import { defineConfig } from 'drizzle-kit';

// الأنواع تُستبطَن من قاعدة بيانات مُرحَّلة (ADR 0001)؛ لا يُكتب المخطط يدويًا.
export default defineConfig({
  dialect: 'postgresql',
  out: process.env.DRIZZLE_OUT ?? './src/database/schema',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  tablesFilter: ['!schema_migrations'],
  introspect: { casing: 'camel' },
});
