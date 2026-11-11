import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * لا محرف اتجاه خام ولا مسافة غير منكسرة في نصوص الحزمة: لا تُرى في المراجعة وتغيّر ما يُعرض.
 * البديل: تسلسل هروب في الكود، أو `bdi`/`dir` في الواجهة، أو نص عادي. المحارف تُبنى هنا من أرقامها كي لا يحملها هذا الملف نفسه.
 */
const marks = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x00a0];
const raw = new RegExp(`[${marks.map(code => String.fromCharCode(code)).join("")}]`);
const root = join(__dirname, ".."), skipped = new Set(["node_modules", ".next", ".artifacts", "test-results", "playwright-report", "generated", "public"]);
const text = /\.(ts|tsx|mjs|cjs|js|json|css|md|sh|yml|yaml|txt)$/;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (skipped.has(entry.name) ? [] : files(join(dir, entry.name))) : text.test(entry.name) ? [join(dir, entry.name)] : []);

describe("source text", () => {
  it("carries no raw direction mark or non-breaking space", () => {
    const found = files(root).flatMap(file => readFileSync(file, "utf8").split("\n").flatMap((line, i) => raw.test(line) ? [`${relative(root, file)}:${i + 1}: U+${line.match(raw)![0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`] : []));
    expect(found).toEqual([]);
  });
  it("catches each of those characters when one is present", () => {
    for (const code of marks) expect(raw.test(`a${String.fromCharCode(code)}b`)).toBe(true);
    expect(raw.test("نص عادي with plain text 100%")).toBe(false);
  });
});
