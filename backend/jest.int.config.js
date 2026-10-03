/** Integration tests: require PostgreSQL and Redis (see README, `docker compose up -d postgres redis`). */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/integration/.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Prisma's generated client imports './x.js' for TypeScript sources.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  setupFiles: ['<rootDir>/test/integration/env.ts'],
  maxWorkers: 1,
  testTimeout: 30000,
};
