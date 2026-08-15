import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { configValidationSchema } from './config.schema';

// Default to the live root .env (mainnet), but allow BOSPHOR_ENV_FILE to point at
// a different env file (e.g. relayer/.env.testnet) so a testnet relayer never
// picks up mainnet config. Mirrors the deploy/e2e scripts.
const envFilePath = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(__dirname, '../../..', '.env');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
      validationSchema: configValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
  ],
})
export class AppConfigModule {}
