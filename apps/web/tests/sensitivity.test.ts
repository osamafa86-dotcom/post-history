import { describe, expect, it } from "vitest";
import { sensitivityState } from "../src/lib/sensitivity";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

describe("the W2 sensitivity line never reassures about data it does not have", () => {
  it("reads «unknown» when the field is missing, null, not an object, or lacks a flag", () => {
    for (const value of [undefined, null, "", 0, "yes", [], {}, { minors: false, injured: false }, { minors: false, injured: false, graphic: null }, { minors: "false", injured: false, graphic: false }])
      expect(sensitivityState(value), JSON.stringify(value)).toEqual({ known: false });
  });
  it("reads «not flagged» only when all three flags are present and false", () => {
    expect(sensitivityState({ minors: false, injured: false, graphic: false })).toEqual({ known: true, flags: [] });
  });
  it("lists the flags that are set, in the contract's order", () => {
    expect(sensitivityState({ graphic: true, minors: true, injured: false })).toEqual({ known: true, flags: ["minors", "graphic"] });
    expect(sensitivityState({ minors: false, injured: true, graphic: false })).toEqual({ known: true, flags: ["injured"] });
  });
  it("has the unknown wording and its rule in both languages", () => {
    expect(ar.shell.material.sensitivityUnknown).toBe("غير معروف");
    expect(en.shell.material.sensitivityUnknown).toBe("Unknown");
    expect(ar.shell.material.unknownRule).toBe("تعامَل معها كحساسة حتى تُعرف.");
    expect(en.shell.material.unknownRule).toBe("treat as sensitive until known.");
  });
});
