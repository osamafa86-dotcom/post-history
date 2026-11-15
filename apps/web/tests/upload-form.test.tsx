import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DynamicForm } from "../src/components/dynamic-form";
import { webUnavailable } from "../src/lib/forms";
import type { Form } from "../src/lib/types";
import ar from "../messages/ar.json" with { type: "json" };

const form = (required: boolean) => ({ version: 3, published_at: "2026-11-01T00:00:00Z", published_by: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", fields: [
  { key: "release", type: "attachment", label: { ar: "البيان الصحفي", en: "Press release" }, required },
  { key: "producer", type: "staff_member", label: { ar: "المنتج الميداني", en: "Field producer" }, required: false },
  { key: "summary", type: "long_text", label: { ar: "ملخص", en: "Summary" }, required: false },
] }) as Form;
const render = (required: boolean, unavailable = webUnavailable as readonly Form["fields"][number]["type"][]) => renderToStaticMarkup(<DynamicForm schema={form(required)} type="report" permissions={[]} locale="ar" onSubmit={() => undefined} submitLabel="إرسال" unavailable={unavailable} />);

describe("the upload form draws what the web cannot fill as disabled, with the reason", () => {
  it("disables the attachment and the staff member and says why under each", () => {
    const html = render(false);
    expect(html).toMatch(/<input id="field-release" disabled=""[^>]*>/); expect(html).toMatch(/<input id="field-producer" disabled=""[^>]*>/);
    expect(html).not.toContain('type="file"');
    expect(html.split(ar.fieldUnavailable).length - 1).toBe(2);
    expect(html).not.toContain("form-blocked"); expect(html).toMatch(/<button>إرسال<\/button>/);
  });
  it("names a required one before sending, and does not offer a send that would fail", () => {
    const html = render(true);
    expect(html).toContain('data-testid="form-blocked"'); expect(html).toContain("«البيان الصحفي»");
    expect(html).toMatch(/<button disabled="">إرسال<\/button>/);
  });
  it("keeps both fields live where nothing is declared unavailable (the form preview)", () => {
    const html = render(true, []);
    expect(html).toContain('type="file"'); expect(html).not.toContain(ar.fieldUnavailable); expect(html).not.toContain("form-blocked");
  });
});
