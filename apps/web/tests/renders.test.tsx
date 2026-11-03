import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderDialog } from "../src/components/render-dialog";
import { byTemplate, canSubmit, cleanLine, codePoints, initialDraft, isSensitive, lineOver, locationPreview, pollRenders, renderDetails, renderInput, renderPollMs, renderRequest, renderTemplates, safeRender, shouldPoll, splitTitle, validLine } from "../src/lib/render-policy";
import type { Material, MaterialRender } from "../src/lib/types";
import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { material } from "./fixtures";

const sample = (patch: Partial<Material> = {}): Material => ({ ...material(2), title: "عنوان تجريبي", city: "مدينة", governorate: "محافظة", editorial_state: "accepted", ...patch });
const render = (patch: Partial<MaterialRender> = {}): MaterialRender => ({
  id: "60000000-0000-4000-8000-000000000001", material_id: sample().id, material_version: 1, source_file_id: "50000000-0000-4000-8000-000000000002", template: "circulated",
  aspect: "vertical", title_lines: ["عنوان تجريبي"], show_location: true, location_text: "مدينة، محافظة", label: "none", state: "requested", file_id: null, failure_reason: null,
  requested_by: "10000000-0000-4000-8000-000000000001", requested_at: "2026-11-03T14:50:00Z", started_at: null, completed_at: null, ...patch,
});
// 22 نقطة ترميز من خارج المستوى الأساسي: 44 وحدة UTF-16.
const astral22 = "\u{1D49C}".repeat(22);

describe("title line counter counts code points like the server", () => {
  it("counts an astral character once and each combining mark on its own", () => {
    expect(codePoints("\u{1D49C}")).toBe(1); expect("\u{1D49C}".length).toBe(2);
    expect(codePoints("عَ")).toBe(2);
    expect(codePoints(astral22)).toBe(22); expect(astral22.length).toBe(44);
    expect(lineOver(astral22)).toBe(false); expect(validLine(astral22)).toBe(true);
    expect(lineOver(`${astral22}x`)).toBe(true); expect(validLine(`${astral22}x`)).toBe(false);
  });
  it("cleans control and direction characters on input and rejects edge spaces", () => {
    expect(cleanLine("عنوان\u200F تجريبي\n\u202B")).toBe("عنوان تجريبي");
    expect(validLine(" عنوان")).toBe(false); expect(validLine("عنوان ")).toBe(false); expect(validLine("عنوان\u061C")).toBe(false); expect(validLine("عنوان تجريبي")).toBe(true);
  });
  it("splits the material title on words into the fewest balanced lines", () => {
    expect(splitTitle("عنوان تجريبي")).toEqual(["عنوان تجريبي"]);
    expect(splitTitle("عنوان تجريبي للمادة المتداولة")).toEqual(["عنوان تجريبي", "للمادة المتداولة"]);
    const long = splitTitle(Array.from({ length: 12 }, () => "عنوان").join(" "));
    expect(long).toHaveLength(3); expect(long.slice(0, 2).every(line => !lineOver(line))).toBe(true); expect(lineOver(long[2])).toBe(true);
  });
  it("blocks submission while any line is over 22 code points", () => {
    const draft = { ...initialDraft(sample()), label: "none" as const };
    expect(canSubmit(draft)).toBe(true);
    expect(canSubmit({ ...draft, lines: ["عنوان تجريبي", `${astral22}x`, ""] })).toBe(false);
    expect(canSubmit({ ...draft, lines: ["", "", ""] })).toBe(false);
  });
});

describe("the label is required with no default", () => {
  it("starts without a label and sends nothing until one is chosen", () => {
    const draft = initialDraft(sample());
    expect(draft.label).toBeNull(); expect(canSubmit(draft)).toBe(false); expect(renderRequest(draft)).toBeNull();
    expect(renderRequest({ ...draft, label: "circulated_footage" })?.label).toBe("circulated_footage");
  });
  it("sends only the five contract fields and never a location text", () => {
    const body = renderRequest({ template: "circulated", aspect: "square", lines: [" عنوان تجريبي ", "", "سطر"], showLocation: true, label: "none" });
    expect(body).toEqual({ template: "circulated", aspect: "square", title_lines: ["عنوان تجريبي", "سطر"], show_location: true, label: "none" });
    expect(JSON.stringify(body)).not.toContain("مدينة");
  });
  it("renders the dialog with the submit disabled and no label checked", () => {
    const html = renderToStaticMarkup(<RenderDialog locale="ar" material={sample()} onClose={() => {}} onCreated={() => {}} onRefused={() => {}} />);
    expect(html).toMatch(/<button type="submit" disabled="">/); expect(html).not.toMatch(/name="render-label"[^>]*checked/); expect(html).toContain(ar.derivative.template.chooseLabelFirst);
  });
});

describe("location defaults by sensitivity and is previewed from city and governorate only", () => {
  it("is off for flagged or unknown sensitivity and on otherwise", () => {
    expect(isSensitive(sample())).toBe(false); expect(initialDraft(sample()).showLocation).toBe(true);
    expect(initialDraft(sample({ sensitivity: { minors: false, injured: true, graphic: false } })).showLocation).toBe(false);
    expect(initialDraft(sample({ sensitivity: undefined as unknown as Material["sensitivity"] })).showLocation).toBe(false);
  });
  it("builds the preview as the server will draw it", () => {
    expect(locationPreview(sample())).toBe("مدينة، محافظة"); expect(locationPreview(sample({ governorate: "مدينة" }))).toBe("مدينة");
  });
  it("shows the sensitive hint with the switch off, and the preview text when on", () => {
    const sensitive = renderToStaticMarkup(<RenderDialog locale="en" material={sample({ sensitivity: { minors: true, injured: false, graphic: false } })} onClose={() => {}} onCreated={() => {}} onRefused={() => {}} />);
    expect(sensitive).toContain(en.derivative.template.locationOffSensitive); expect(sensitive).not.toMatch(/role="switch"[^>]*checked/); expect(sensitive).toContain(en.derivative.template.noteSensitive);
    const open = renderToStaticMarkup(<RenderDialog locale="ar" material={sample()} onClose={() => {}} onCreated={() => {}} onRefused={() => {}} />);
    expect(open).toMatch(/checked=""[^>]*role="switch"|role="switch"[^>]*checked=""/); expect(open).toContain("<bdi>مدينة، محافظة</bdi>");
  });
  it("prefills a new request from a failed copy, label included", () => {
    expect(initialDraft(sample({ sensitivity: { minors: true, injured: false, graphic: false } }), render({ aspect: "horizontal", title_lines: ["سطر"], show_location: true, label: "circulated_footage" })))
      .toEqual({ template: "circulated", aspect: "horizontal", lines: ["سطر", "", ""], showLocation: true, label: "circulated_footage" });
  });
});

// قالب «الشاهد» (ADR 0109 و0110): خيار في الطلب نفسه، والنسخ تُعرض بقالبها
describe("the template is a choice in the same request", () => {
  it("opens on the circulated template, sends the chosen one, and a failed Witness copy reopens on Witness", () => {
    expect(renderTemplates).toEqual(["circulated", "witness"]);
    const draft = { ...initialDraft(sample()), label: "none" as const };
    expect(draft.template).toBe("circulated"); expect(renderRequest(draft)?.template).toBe("circulated");
    expect(renderRequest({ ...draft, template: "witness" })).toEqual({ template: "witness", aspect: "vertical", title_lines: ["عنوان تجريبي"], show_location: true, label: "none" });
    expect(initialDraft(sample(), render({ template: "witness", aspect: "square" }))).toMatchObject({ template: "witness", aspect: "square" });
  });
  it("draws both template options with circulated checked, and the Witness title hint only for Witness", () => {
    const html = renderToStaticMarkup(<RenderDialog locale="ar" material={sample()} onClose={() => {}} onCreated={() => {}} onRefused={() => {}} />);
    expect(html).toContain(ar.derivative.templates.circulated); expect(html).toContain(ar.derivative.templates.witness); expect(html).toContain(ar.derivative.template.templateHint);
    const radio = (value: string) => html.match(new RegExp(`<input[^>]*name="render-template"[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
    expect(radio("circulated")).toContain('checked=""'); expect(radio("witness")).not.toContain("checked");
    expect(html).not.toContain(ar.derivative.template.witnessTitleHint); expect(html).toMatch(/class="render-preview vertical circulated"/);
    const witness = renderToStaticMarkup(<RenderDialog locale="en" material={sample()} from={render({ template: "witness", state: "failed", failure_reason: "title_overflow" })} onClose={() => {}} onCreated={() => {}} onRefused={() => {}} />);
    expect(witness).toContain(en.derivative.template.witnessTitleHint); expect(witness).toMatch(/class="render-preview vertical witness"/); expect(witness).toContain("preview-corners");
  });
  it("the BFF accepts both templates and nothing else, and keeps the template on the row", () => {
    const body = { template: "witness", aspect: "horizontal", title_lines: ["عنوان"], show_location: true, label: "circulated_footage" };
    expect(renderInput(body)).toEqual(body);
    for (const template of ["Witness", "urgent", "default", "", null, undefined]) expect(renderInput({ ...body, template } as Record<string, unknown>)).toBeNull();
    expect(safeRender(render({ template: "witness" }))?.template).toBe("witness");
    expect(safeRender(render({ template: "urgent" as MaterialRender["template"] }))).toBeNull();
  });
  it("groups copies by template in template order, newest first inside each", () => {
    const a = render({ id: "60000000-0000-4000-8000-00000000000a", template: "witness" }), b = render({ id: "60000000-0000-4000-8000-00000000000b" }), c = render({ id: "60000000-0000-4000-8000-00000000000c", template: "witness" });
    expect(byTemplate([a, b, c]).map(g => [g.template, g.items.map(i => i.id)])).toEqual([["circulated", [b.id]], ["witness", [a.id, c.id]]]);
    expect(byTemplate([b]).map(g => g.template)).toEqual(["circulated"]); expect(byTemplate([])).toEqual([]);
  });
});

describe("BFF render policy", () => {
  it("accepts only the closed request schema", () => {
    const body = { template: "circulated", aspect: "vertical", title_lines: [astral22], show_location: false, label: "none" };
    expect(renderInput(body)).toEqual(body);
    for (const bad of [{ ...body, location_text: "مدينة" }, { ...body, title_lines: ["a", "b", "c", "d"] }, { ...body, title_lines: [`${astral22}x`] }, { ...body, title_lines: ["عنوان\u200F"] }, { ...body, label: undefined }, { ...body, aspect: "portrait" }]) expect(renderInput(bad as Record<string, unknown>)).toBeNull();
  });
  it("whitelists render rows and drops rows that break the contract", () => {
    expect(safeRender({ ...render(), extra: "canary" } as MaterialRender)).toEqual(render());
    expect(safeRender(render({ state: "paused" as MaterialRender["state"] }))).toBeNull();
    expect(safeRender(render({ file_id: "not-a-uuid" }))).toBeNull();
  });
  it("keeps only known failed conditions and a positive duration limit", () => {
    expect(renderDetails({ failed: ["source", "canary", "rights_state"], max_source_duration_ms: 300000, message: "x" })).toEqual({ failed: ["source", "rights_state"], max_source_duration_ms: 300000 });
    expect(renderDetails({ failed: "source", max_source_duration_ms: -1 })).toEqual({ failed: [] });
  });
});

describe("polling", () => {
  afterEach(() => { vi.useRealTimers(); });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  it("polls every ten seconds while a copy is requested or rendering and stops when none is", async () => {
    vi.useFakeTimers();
    const pages = [[render({ state: "rendering", started_at: "2026-11-03T14:55:00Z" })], [render({ state: "ready", file_id: "70000000-0000-4000-8000-000000000001", completed_at: "2026-11-03T14:58:00Z" })]];
    const load = vi.fn(async () => pages[Math.min(load.mock.calls.length - 1, 1)]), seen: unknown[] = [];
    const stop = pollRenders(load, result => seen.push(result), () => 503);
    await flush(); expect(load).toHaveBeenCalledTimes(1); expect(shouldPoll(pages[0])).toBe(true);
    await vi.advanceTimersByTimeAsync(renderPollMs - 1); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(renderPollMs * 5); expect(load).toHaveBeenCalledTimes(2); expect(seen).toHaveLength(2);
    stop();
  });
  it("stops on 404 (feature off) and when the card unmounts", async () => {
    vi.useFakeTimers();
    const missing = vi.fn(async () => { throw new Error("404"); }), seen: unknown[] = [];
    pollRenders(missing, result => seen.push(result), () => 404);
    await vi.advanceTimersByTimeAsync(renderPollMs * 3); expect(missing).toHaveBeenCalledTimes(1); expect(seen).toEqual([{ status: 404 }]);
    const busy = vi.fn(async () => [render()]), stop = pollRenders(busy, () => {}, () => 503);
    await flush(); stop(); await vi.advanceTimersByTimeAsync(renderPollMs * 3); expect(busy).toHaveBeenCalledTimes(1);
  });
});
