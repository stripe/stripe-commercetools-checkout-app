/** @type {import('ts-jest').JestConfigWithTsJest} */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['./test/jest.setup.ts'],
  roots: ['./test'],
  // @commercetools/connect-payments-sdk pulls in jose (via jwks-rsa) as an
  // ESM-only package. Transform it to CommonJS instead of ignoring it so Jest
  // can load the SDK's security module.
  transformIgnorePatterns: ['/node_modules/(?!jose/)'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.js$': ['ts-jest', { isolatedModules: true, tsconfig: { allowJs: true, module: 'CommonJS' } }],
  },
};
