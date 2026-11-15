import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaPreview } from "../src/components/media-preview";
import { pictureBox, staffPreview } from "../src/lib/preview-policy";
import { playerType, proxyType } from "../src/lib/player-policy";
import type { MaterialFile } from "../src/lib/types";
import { material } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const id = (group: number, index: number) => `${group}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const file = (patch: Partial<MaterialFile> & { derived_from_id?: string | null }) => ({ state: "verified", created_at: "2026-11-03T09:00:00Z", ...patch }) as MaterialFile;
const original = (n: number) => file({ id: id(5, n), kind: "original", mime_type: "video/mp4" });
const proxy = (n: number) => file({ id: id(3, n), kind: "proxy", mime_type: "video/mp4", derived_from_id: id(5, n) });
const thumbnail = (n: number) => file({ id: id(4, n), kind: "thumbnail", mime_type: "image/jpeg", derived_from_id: id(5, n) });

describe("a material with several videos plays each of them", () => {
  it("pairs every server-made light copy with the thumbnail made from the same original, in file order", () => {
    const files = [original(1), original(2), proxy(1), thumbnail(2), proxy(2), thumbnail(1)];
    const { clips, proxy: first } = staffPreview({ files, thumbnail_file_id: id(4, 2) });
    expect(clips.map(clip => [clip.proxy.id, clip.thumbnail?.id])).toEqual([[id(3, 1), id(4, 1)], [id(3, 2), id(4, 2)]]);
    expect(first?.id).toBe(id(3, 1));
  });
  it("leaves a clip whose thumbnail is missing or not derived from its original without a picture, and skips the phone's copy", () => {
    const phone = file({ id: id(3, 9), kind: "proxy", mime_type: "video/mp4" }), stray = file({ id: id(4, 9), kind: "thumbnail", mime_type: "image/jpeg" });
    const { clips, thumbnails } = staffPreview({ files: [phone, proxy(1), stray], thumbnail_file_id: null });
    expect(clips).toEqual([{ proxy: expect.objectContaining({ id: id(3, 1) }), thumbnail: null }]); expect(thumbnails).toHaveLength(1);
  });
  it("draws one button per clip with a counter, and no buttons for a single clip", () => {
    const two = renderToStaticMarkup(<MediaPreview locale="ar" material={{ ...material(1), files: [original(1), original(2), proxy(1), proxy(2), thumbnail(1), thumbnail(2)] }} />);
    expect(two.match(/class="clip-button"/g)).toHaveLength(2); expect(two).toContain('aria-pressed="true"'); expect(two.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(two).toContain(ar.clips.counter.replace("{n}", "1").replace("{total}", "2")); expect(two).toContain(ar.clips.open.replace("{n}", "2").replace("{total}", "2"));
    const one = renderToStaticMarkup(<MediaPreview locale="en" material={{ ...material(1), files: [original(1), proxy(1), thumbnail(1)] }} />);
    expect(one).not.toContain("clip-button"); expect(one).not.toContain("clip-counter"); expect(one).not.toContain(en.clips.title);
  });
  it("marks strip thumbnails with the short mark, which fits them, and keeps the full mark for the player", () => {
    const html = renderToStaticMarkup(<MediaPreview locale="ar" material={{ ...material(1), files: [original(1), proxy(1), thumbnail(1)] }} />);
    expect(html).toContain(`<span class="watermark short">${ar.watermarkShort}</span>`); expect(html).toContain(`<span class="watermark">${ar.watermark}</span>`);
  });
});

describe("the watermark sits on the picture, not on the bars beside it", () => {
  it("finds the picture inside a frame that contains it", () => {
    // مقطع طولي 480×854 في إطار عرضي 752×540: الصورة في الوسط بعرض 303.5
    const box = pictureBox(752, 540, 480, 854);
    expect(box.h).toBe(540); expect(box.w).toBeCloseTo(303.5, 1); expect(box.x).toBeCloseTo(224.25, 1); expect(box.y).toBe(0);
    expect(pictureBox(640, 640, 1920, 1080)).toEqual({ x: 0, y: 140, w: 640, h: 360 });
  });
  it("falls back to the whole frame while the clip's size is unknown", () => {
    expect(pictureBox(640, 360, 0, 0)).toEqual({ x: 0, y: 0, w: 640, h: 360 }); expect(pictureBox(0, 0, 480, 854)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(pictureBox(640, 360, Number.NaN, 100)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });
});

describe("the player declares the light copy's codecs when the browser plays them", () => {
  it("names H.264 and AAC only to a browser that says it plays them", () => {
    expect(playerType(type => type === proxyType ? "probably" : "")).toBe(proxyType);
    expect(playerType(() => "")).toBe("video/mp4");
    expect(proxyType).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}, mp4a\.40\.2"$/i);
  });
});
