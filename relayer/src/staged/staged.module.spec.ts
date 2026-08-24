import { Test } from '@nestjs/testing';
import { StagedModule } from './staged.module';
import { StagedIntentStore } from './staged-intent.store';
import { StagedReaper } from './staged-reaper.service';

/**
 * Regression guard for the DI-erasure bug that shipped in the durable-queue
 * feature: the module constructor injected `StagedIntentStore | null` without an
 * explicit @Inject token, so Nest resolved it to null and never created the
 * staged_intent table. It only surfaced with a real DATABASE_URL (the store is
 * non-null). Boot the real module and assert init() runs. StagedReaper is stubbed
 * so its unrelated deps (ConfigService/ErrorReporter/MetricsService) need not be
 * wired here - this test is about the module's own store injection.
 */
describe('StagedModule', () => {
  it('runs store.init() on bootstrap when a store is present', async () => {
    const init = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({ imports: [StagedModule] })
      .overrideProvider(StagedIntentStore)
      .useValue({ init })
      .overrideProvider(StagedReaper)
      .useValue({})
      .compile();

    await moduleRef.init();
    // If the @Inject token is dropped, the `| null` union erases the DI metadata,
    // the store injects as null, and init() is never called - failing here.
    expect(init).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
