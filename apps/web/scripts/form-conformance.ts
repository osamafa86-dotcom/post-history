import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validate } from "../src/lib/forms";
import type { Form, MaterialType, Values } from "../src/lib/types";
const root = resolve("../../tools/acceptance/form-conformance");
const suite = JSON.parse(readFileSync(resolve(root, "cases.json"), "utf8")) as {
  forms: Record<string, string>; cases: { id: string; form: string; material_type: MaterialType; values: Values }[];
};
const forms = Object.fromEntries(Object.entries(suite.forms).map(([key, file]) => [key, JSON.parse(readFileSync(resolve(root, file), "utf8")) as Form]));
const results = Object.fromEntries(suite.cases.map(c => [c.id, validate(forms[c.form], c.material_type, c.values)]));
mkdirSync(".artifacts", { recursive: true });
writeFileSync(".artifacts/web.json", JSON.stringify({ platform: "web", results }, null, 2) + "\n");
