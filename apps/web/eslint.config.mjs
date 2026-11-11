import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals, ...nextTypescript,
  // لغة المنسّق مثبّتة الأرقام: `numberLocale` أو `dateLocale` من `src/lib/format.ts`، لا رمز اللغة الخام (أرقامه الافتراضية تختلف بين المتصفحات).
  { files: ["src/**/*.{ts,tsx}"], rules: { "no-restricted-syntax": ["error", { selector: "NewExpression[callee.object.name='Intl'][arguments.0.type='Identifier']", message: "Pin the formatter's locale with numberLocale() or dateLocale() from @/lib/format." }] } },
  globalIgnores([".next/**", "src/generated/**", ".artifacts/**", "test-results/**", "playwright-report/**", "next-env.d.ts"]),
]);
