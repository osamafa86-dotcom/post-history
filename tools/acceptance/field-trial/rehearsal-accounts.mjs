// Test accounts for rehearsing the pack against a database you control (CI's compose stack, a local one): seeds the throwaway
// users live/seed.mjs makes and prints them as the FT_ACCOUNTS JSON. Never for a real host: there the supervisor creates the test
// accounts and hands them over. The passwords are random per run.
//   DATABASE_URL=… API_URL=http://127.0.0.1:3000/v1  export FT_ACCOUNTS="$(node field-trial/rehearsal-accounts.mjs)"
import { seed } from "../live/seed.mjs";

if (!process.env.DATABASE_URL || !process.env.API_URL) { console.error("DATABASE_URL and API_URL are required"); process.exit(2); }
const s = await seed({ databaseUrl: process.env.DATABASE_URL, apiUrl: process.env.API_URL });
console.log(JSON.stringify(Object.fromEntries(Object.entries(s.users).map(([role, u]) => [role, { email: u.email, password: s.password }]))));
