/** @type {import('jest').Config} */
const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
};

module.exports = {
  // تقرير التغطية في CI (npm run test:coverage): الوحدات والتكامل معًا
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/generated/**', '!src/database/schema/**', '!src/db/**'],
  coverageReporters: ['text', 'text-summary'],
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.spec.ts'] },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/integration/env.ts'],
    },
  ],
};
