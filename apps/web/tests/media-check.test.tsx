import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaPreview } from "../src/components/media-preview";
import { invalidOriginals, staffPreview } from "../src/lib/preview-policy";
import { hasInvalidFile, mineBucket, needsAction } from "../src/lib/my-materials";
import { safeMaterial } from "../src/lib/privacy";
import type { Material, MaterialFile } from "../src/lib/types";
import { material } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const original = (n: number, check?: unknown) => ({ id: `50000000-0000-4000-8000-00000000000${n}`, kind: "original", state: "verified", mime_type: "video/mp4", created_at: "2026-11-15T09:00:00Z", ...(check === undefined ? {} : { media_check: check }) }) as MaterialFile;
const with_ = (files: MaterialFile[], patch: Partial<Material> = {}): Material => ({ ...material(1), ...patch, files });

describe("an original the worker could not read says so, and nothing waits for its preview", () => {
  it("the BFF passes the check only as `invalid`", () => {
    const safe = safeMaterial(with_([original(1, "invalid"), original(2, null), original(3, "<b>"), original(4)]), []).files as (MaterialFile & { media_check?: unknown })[];
    expect(safe.map(file => file.media_check)).toEqual(["invalid", undefined, undefined, undefined]);
  });
  it("counts the invalid originals of a material", () => {
    expect(invalidOriginals(with_([original(1, "invalid"), original(2)]))).toEqual({ invalid: 1, total: 2 });
    expect(invalidOriginals(with_([original(1)]))).toEqual({ invalid: 0, total: 1 });
    expect(staffPreview(with_([original(1, "invalid")])).invalid).toBe(true); expect(staffPreview(with_([original(1)])).invalid).toBe(false);
  });
  it("the preview says the file is not valid media instead of «preparing», in both languages", () => {
    for (const [locale, m] of [["ar", ar], ["en", en]] as const) {
      const html = renderToStaticMarkup(<MediaPreview locale={locale} material={with_([original(1, "invalid")])} />);
      expect(html).toContain(m.mediaInvalid.preview); expect(html).not.toContain(m.previewPreparing);
    }
    // ملف صالح بجانبه ما زال يُنتظر، وملف له معاينة تُعرض معاينته
    expect(renderToStaticMarkup(<MediaPreview locale="ar" material={with_([original(1, "invalid"), original(2)])} />)).toContain(ar.previewPreparing);
  });
  it("puts the material under «needs your action» for its reporter, until the desk has decided on it", () => {
    const bad = with_([original(1, "invalid")]);
    expect(hasInvalidFile(bad)).toBe(true); expect(needsAction(bad)).toBe(true); expect(mineBucket(bad)).toBe("action");
    expect(hasInvalidFile(with_([original(1)]))).toBe(false); expect(mineBucket(with_([original(1)]))).toBe("reviewing");
    expect(mineBucket({ ...bad, editorial_state: "rejected" })).toBe("rejected");
  });
});
