import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { safeVerification } from "../src/lib/issued-licenses";
import { catalogParams } from "../src/components/store/store-catalog";
import { CatalogCard } from "../src/components/store/catalog-card";
import { licenseTone } from "../src/components/store/license-verify";
import { MemoryStore } from "./memory-store";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const full = { license_number: "PH-2026-7K3M9Q2XRT", status: "active", license_type: "editorial_single", title: { ar: "canary", en: "canary" }, usage_media: ["web"], territory: { kind: "worldwide" }, valid_from: "2026-10-21T10:00:00Z", valid_until: null, exclusive_until: null, organization: "canary" } as const;

describe("buyer flow (#385)", () => {
  it("the public verification shows the licence number and status only", () => {
    expect(safeVerification(full as never)).toEqual({ license_number: "PH-2026-7K3M9Q2XRT", status: "active" });
  });
  it("verifies without a session, never forwards a cookie, and refuses malformed numbers without calling the API", async () => {
    const seen: Request[] = [];
    const fetch = (async (input: Request) => { seen.push(input); return Response.json(full); }) as typeof globalThis.fetch;
    const ok = await handle(new NextRequest(`${config.origin}/api/bff/license-verifications/PH-2026-7K3M9Q2XRT`), "license-verifications/PH-2026-7K3M9Q2XRT", { config, store: new MemoryStore(), fetch });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ license_number: "PH-2026-7K3M9Q2XRT", status: "active" });
    expect(ok.headers.get("cache-control")).toBe("no-store"); expect(seen[0].headers.get("authorization")).toBeNull();
    const bad = await handle(new NextRequest(`${config.origin}/api/bff/license-verifications/PH-1`), "license-verifications/PH-1", { config, store: new MemoryStore(), fetch });
    expect(bad.status).toBe(404); expect(seen).toHaveLength(1);
  });
  it("maps catalog filters to contract parameters", () => {
    expect(catalogParams({ q: "غزة", duration: "medium", min_height: "1080", exclusive_available: "true", governorate: "" }).toString())
      .toBe(new URLSearchParams({ q: "غزة", min_duration_ms: "60000", max_duration_ms: "300000", min_height: "1080", exclusive_available: "true" }).toString());
    expect(catalogParams({ duration: "short" }).get("max_duration_ms")).toBe("60000");
  });
  it("the card carries trust and exclusivity without fingerprints or identifiers", () => {
    const html = renderToStaticMarkup(<CatalogCard locale="en" item={{ href: "/en/store/x", title: { ar: "ع", en: "Footage" }, governorate: "Gaza", shotOn: "2026-10-19T13:45:00Z", durationMs: 65000, width: 1920, height: 1080, displayName: "Palestine Post", from: { amount_minor: 15000, currency: "USD" }, types: ["raw_footage"], licenses: ["editorial_single", "exclusive_temporary"], exclusive: true }} />);
    expect(html).toContain(en.store.browse.verified); expect(html).toContain(en.store.browse.exclusive); expect(html).toContain(en.store.licenseTypes.exclusive_temporary);
    expect(html).not.toMatch(/13:45|sha256|fingerprint/i);
  });
  it("tones licence statuses: active good, expired neutral, revoked bad", () => {
    expect(["active", "expired", "revoked"].map(s => licenseTone(s as never))).toEqual(["good", "", "bad"]);
  });
});
