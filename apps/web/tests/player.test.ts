import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { allowPlayerRequest, playerSource } from "../src/lib/player-policy";
import { localPlayerCss } from "../scripts/player-css.mjs";
const path = "/api/bff/materials/10000000-0000-4000-8000-000000000001/files/20000000-0000-4000-8000-000000000001/content";
describe("player trust boundary", () => {
  it("only resolves exact derivative paths", () => {
    expect(playerSource(path, "https://example.test")).toBe(`https://example.test${path}`);
    for (const bad of ["https://other.test" + path, "//other.test" + path, path + "?token=x", path + "#x", path + "/../content", "javascript:alert(1)", "/api/bff/auth/me"]) expect(() => playerSource(bad, "https://example.test")).toThrow();
  });
  it("rejects fallback hosts and alternate URLs", () => {
    const source = playerSource(path, "https://example.test");
    expect(allowPlayerRequest([source], source)).toBe(true);
    for (const uris of [[], [source + "?x=1"], [source, "https://other.test/x"]]) expect(allowPlayerRequest(uris, source)).toBe(false);
  });
  it("keeps generated CSS local and preserves the upstream license", async () => {
    const input = await readFile(new URL("../node_modules/shaka-player/dist/controls.css", import.meta.url), "utf8");
    const output = await readFile(new URL("../src/generated/player.css", import.meta.url), "utf8");
    expect(output).toBe(localPlayerCss(input)); expect(output).toContain("Apache");
    expect(output).not.toMatch(/@font-face|@import|url\(\s*["']?\s*(?:https?:)?\/\//i);
  });
  it("fails closed on unexpected remote CSS", () => {
    for (const css of ["@import 'x.css';", "x{background:url(//cdn.test/x)}", "x{background:url(https://cdn.test/x)}"]) expect(() => localPlayerCss(css)).toThrow();
  });
});
