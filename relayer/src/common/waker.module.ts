import { Global, Module } from '@nestjs/common';
import { StoreQueueWaker } from './store-queue-waker';

/**
 * Provides the shared StoreQueueWaker app-wide (Global) so producers (ingest,
 * receive) and the consumer (processor) can share the wake signal without a
 * circular module dependency.
 */
@Global()
@Module({
  providers: [StoreQueueWaker],
  exports: [StoreQueueWaker],
})
export class WakerModule {}
