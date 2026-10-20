import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const ajv = new Ajv2020({ strict: false, allowUnionTypes: true }); addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync("../../contracts/schemas/measurement.json", "utf8")));
const directory = "../../docs/measurements/web";
const files = readdirSync(directory).filter(file => file.endsWith(".json"));
if (!files.length) throw new Error("A web measurement is required");
for (const file of files) {
  if (!validate(JSON.parse(readFileSync(`${directory}/${file}`, "utf8")))) throw new Error(`${file}: ${ajv.errorsText(validate.errors)}`);
}
console.log(`${files.length} web measurement(s) match measurement.json`);
