import { ServiceUnavailableException } from '@nestjs/common';
import { PublicController } from './public.controller';
import { InMemoryIntentLifecycleStore } from './in-memory-intent-lifecycle.store';
import { IntentLifecycleStore } from './intent-lifecycle.store';

describe('PublicController GET /public/intents', () => {
  it('serves the recent feed newest-first with a count', async () => {
    const store = new InMemoryIntentLifecycleStore();
    await store.recordHop('0xold', 'submitted', { timestamp: 1000 });
    await store.recordHop('0xnew', 'submitted', { timestamp: 2000 });
    const controller = new PublicController(store);

    const res = await controller.getIntents();

    expect(res.count).toBe(2);
    expect(res.intents.map((i) => i.intentId)).toEqual(['0xnew', '0xold']);
  });

  it('surfaces an explicit error (no fabricated feed) when the store fails', async () => {
    const failing = {
      getRecentIntents: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as IntentLifecycleStore;
    const controller = new PublicController(failing);

    await expect(controller.getIntents()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('clamps the limit to the allowed maximum', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const spy = jest.spyOn(store, 'getRecentIntents');
    const controller = new PublicController(store);

    await controller.getIntents('9999');

    expect(spy).toHaveBeenCalledWith(200);
  });

  it('defaults the limit when none is supplied', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const spy = jest.spyOn(store, 'getRecentIntents');
    const controller = new PublicController(store);

    await controller.getIntents();

    expect(spy).toHaveBeenCalledWith(50);
  });
});
