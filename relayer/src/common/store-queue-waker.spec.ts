import { StoreQueueWaker } from './store-queue-waker';

describe('StoreQueueWaker', () => {
  it('notifies every registered listener on wake', () => {
    const waker = new StoreQueueWaker();
    const a = jest.fn();
    const b = jest.fn();
    waker.onWake(a);
    waker.onWake(b);

    waker.wake();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const waker = new StoreQueueWaker();
    const a = jest.fn();
    const off = waker.onWake(a);
    off();

    waker.wake();

    expect(a).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener so producers are never broken', () => {
    const waker = new StoreQueueWaker();
    const bad = jest.fn(() => {
      throw new Error('listener blew up');
    });
    const good = jest.fn();
    waker.onWake(bad);
    waker.onWake(good);

    expect(() => waker.wake()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
