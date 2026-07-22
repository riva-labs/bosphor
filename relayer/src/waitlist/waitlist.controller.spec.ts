import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryWaitlistStore } from './in-memory-waitlist.store';
import { WaitlistController } from './waitlist.controller';
import { WaitlistStore } from './waitlist.store';

function configWith(token?: string): ConfigService {
  return { get: (k: string) => (k === 'WAITLIST_EXPORT_TOKEN' ? token : undefined) } as ConfigService;
}

describe('WaitlistController', () => {
  it('registers a valid email and reports created', async () => {
    const controller = new WaitlistController(new InMemoryWaitlistStore(), configWith());
    const res = await controller.join({ email: 'Dev@Bosphor.xyz', source: 'dashboard' });
    expect(res).toEqual({ ok: true, created: true });
  });

  it('reports created=false on a duplicate signup', async () => {
    const store = new InMemoryWaitlistStore();
    const controller = new WaitlistController(store, configWith());
    await controller.join({ email: 'dev@bosphor.xyz' });
    expect(await controller.join({ email: 'dev@bosphor.xyz' })).toEqual({ ok: true, created: false });
  });

  it('rejects a malformed email with 400', async () => {
    const controller = new WaitlistController(new InMemoryWaitlistStore(), configWith());
    await expect(controller.join({ email: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces a 503 (no fabricated success) when the store fails', async () => {
    const failing = { add: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as WaitlistStore;
    const controller = new WaitlistController(failing, configWith());
    await expect(controller.join({ email: 'dev@bosphor.xyz' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('exposes a public count', async () => {
    const store = new InMemoryWaitlistStore();
    await store.add('a@bosphor.xyz');
    const controller = new WaitlistController(store, configWith());
    expect(await controller.count()).toEqual({ count: 1 });
  });

  it('disables export when no token is configured', async () => {
    const controller = new WaitlistController(new InMemoryWaitlistStore(), configWith());
    await expect(controller.export('Bearer anything')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects export with a wrong token', async () => {
    const controller = new WaitlistController(new InMemoryWaitlistStore(), configWith('secret'));
    await expect(controller.export('Bearer wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('exports registrations with the correct bearer token', async () => {
    const store = new InMemoryWaitlistStore();
    await store.add('dev@bosphor.xyz', 'docs');
    const controller = new WaitlistController(store, configWith('secret'));
    const res = await controller.export('Bearer secret');
    expect(res.count).toBe(1);
    expect(res.entries[0].email).toBe('dev@bosphor.xyz');
  });
});
