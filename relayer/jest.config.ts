import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts', 'mjs'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.m?js$': ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@mysten|@noble|@scure|valibot)/)',
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
