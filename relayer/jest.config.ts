import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts', 'mjs'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.m?js$': ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }],
  },
  // rpc-websockets/uuid: ESM deps of the real @solana/web3.js Connection, which
  // the Solana RPC failover spec exercises unmocked.
  transformIgnorePatterns: [
    '/node_modules/(?!(@mysten|@noble|@scure|valibot|@apidevtools|rpc-websockets|uuid)/)',
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
