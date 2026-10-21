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
    // اختبار الأداء بحجم الإنتاج (البند 18): يدوي أو workflow_dispatch، لا في كل PR ولا في التغطية؛ يظهر بقاعدته وحدها
    ...(process.env.PERF_DATABASE_URL
      ? [{ ...base, displayName: 'perf', testMatch: ['<rootDir>/test/perf/**/*.perf.ts'], setupFiles: ['<rootDir>/test/perf/env.ts'] }]
      : []),
  ],
};
