import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { deliveryLate, deliveryLateAfterMs, licenseNumberPattern, normalizeLicenseNumber } from "../src/lib/issued-licenses";
import { LicenseLookup } from "../src/components/store/license-verify";
import { MemoryStore } from "./memory-store";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const number = "PH-2026-7K3M9Q2XRT";

describe("license number as a reader types it", () => {
  it("reads lower case, spaces, missing or typographic hyphens and Arabic digits as the certificate's number", () => {
    for (const typed of ["ph-2026-7k3m9q2xrt", "  PH-2026-7K3M9Q2XRT ", "PH 2026 7K3M9Q2XRT", "ph20267k3m9q2xrt", "PH\u20132026\u20147K3M9Q2XRT", "PH-\u0662\u0660\u0662\u0666-7K3M9Q2XRT", "PH-\u06f2\u06f0\u06f2\u06f6-7K3M9Q2XRT"]) {
      expect(normalizeLicenseNumber(typed), typed).toBe(number);
    }
  });
  it("reads the letters the encoding leaves out as their digits, and never invents a number", () => {
    expect(normalizeLicenseNumber("PH-2O26-OI23456789")).toBe("PH-2026-0123456789");
    expect(normalizeLicenseNumber("ph-2026-ol23456789")).toBe("PH-2026-0123456789");
    for (const typed of ["", "hello", "PH-2026-7K3M9Q2XR", "PH-2026-7K3M9Q2XRTT", "XX-2026-7K3M9Q2XRT", "PH-2026-7K3M9Q2XRU"]) expect(licenseNumberPattern.test(normalizeLicenseNumber(typed)), typed).toBe(false);
  });
});

describe("public verification through the BFF", () => {
  async function verify(typed: string) {
    const calls: string[] = [];
    const fetch = (async (r: Request) => { calls.push(new URL(r.url).pathname); return Response.json({ license_number: number, status: "active", valid_until: null, material: "canary" }); }) as typeof globalThis.fetch;
    const path = `license-verifications/${typed}`;
    const result = await handle(new NextRequest(`${config.origin}/api/bff/${encodeURIComponent(path).replace(/%2F/g, "/")}`, { headers: { "X-Requested-With": "post-history-web" } }), path, { config, store: new MemoryStore(), fetch });
    return { result, calls };
  }
  it("asks the API with the normalized number, whatever the case typed", async () => {
    const { result, calls } = await verify("ph-2026-7k3m9q2xrt");
    expect(result.status).toBe(200); expect(calls).toEqual([`/v1/license-verifications/${number}`]);
    expect(await result.json()).toEqual({ license_number: number, status: "active", valid_until: null });
  });
  it("never sends what is not a license number", async () => {
    const { result, calls } = await verify("PH-2026-SHORT");
    expect(result.status).toBe(404); expect(calls).toEqual([]);
  });
});

describe("the lookup page", () => {
  it("is one field in a GET form that works without scripts, in both languages", () => {
    for (const [locale, v] of [["ar", ar.licenses.verify], ["en", en.licenses.verify]] as const) {
      const html = renderToStaticMarkup(<LicenseLookup locale={locale} typed="" invalid={false} />);
      const form = /<form[^>]*>/.exec(html)![0]; expect(form).toContain(`action="/${locale}/verify"`); expect(form).toContain('method="get"'); expect(html.match(/<input/g)).toHaveLength(1); expect(html).toContain('name="number"');
      expect(html).toContain(v.formLead); expect(html).toContain(v.formSubmit); expect(html).not.toContain(v.formInvalid);
      expect(html).toContain(`href="/${locale === "ar" ? "en" : "ar"}/verify"`);
    }
  });
  it("says what a license number looks like when the typed text is not one, and keeps what was typed", () => {
    const html = renderToStaticMarkup(<LicenseLookup locale="ar" typed="12345" invalid />);
    expect(html).toContain(ar.licenses.verify.formInvalid); expect(html).toContain('value="12345"'); expect(html).toContain('aria-invalid="true"');
  });
});

describe("delivery package delay", () => {
  const issued = Date.parse("2026-11-15T10:00:00Z"), license = { status: "active" as const, delivery_ready: false, issued_at: "2026-11-15T10:00:00Z" };
  it("is late only after the allowance, for an active license whose package is not ready", () => {
    expect(deliveryLate(license, issued + deliveryLateAfterMs)).toBe(false);
    expect(deliveryLate(license, issued + deliveryLateAfterMs + 1)).toBe(true);
    expect(deliveryLate({ ...license, delivery_ready: true }, issued + 10 * deliveryLateAfterMs)).toBe(false);
    expect(deliveryLate({ ...license, status: "revoked" }, issued + 10 * deliveryLateAfterMs)).toBe(false);
  });
});
