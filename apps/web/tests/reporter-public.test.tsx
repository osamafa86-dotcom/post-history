import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import type { Material, Notification } from "../src/lib/types";
import { arabicFold, cardMedia, coverageTitle, dayKind, durationLabel, groupMaterials, matchesFilter, mineCounts, monthName, needsAction, timeSections, type MineGroup } from "../src/lib/my-materials";
import { inTab, knownType, notificationKind, notificationTypes } from "../src/lib/notification-kind";
import { safeNotification } from "../src/lib/privacy";
import { archiveGovernorates, filterArchive, noFilters } from "../src/lib/archive";
import { materialQuery } from "../src/lib/query";
import { groupSecret, inviteInput, safeEnrollment, tokenFromHash, totpInput } from "../src/lib/invite-policy";
import { megabytes, uploadStage } from "../src/components/desktop-upload";
import { payoutWord, SandboxBanner } from "../src/components/earnings";
import { verifyWord } from "../src/components/store/license-verify";
import { OrgPending } from "../src/components/store/org-pending";
import { MemoryStore } from "./memory-store";
import { material, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const item = (patch: Partial<Material>): Material => ({ ...material(), ...patch });
const notice = (patch: Partial<Notification>): Notification => ({ id: "n", type: "", title: "", priority: "normal", state: "delivered", escalation_level: 0, created_at: "2026-11-03T10:00:00Z", read_at: null, acknowledged_at: null, ...patch });

describe("«موادي» mirrors the iOS gallery (ADR 0089 on the web, ADR 0103)", () => {
  it("groups a batch by its coverage title without the (i/N) suffix, folded the Arabic way, newest first", () => {
    expect(coverageTitle("عنوان تجريبي لمادة ميدانية (2/3)")).toBe("عنوان تجريبي لمادة ميدانية");
    expect(arabicFold("إضاءة")).toBe(arabicFold("اضاءه"));
    const items = [item({ id: "a", title: "عنوان تجريبي (1/2)", created_at: "2026-11-03T08:00:00Z" }), item({ id: "b", title: "عنوان تجريبى (2/2)", created_at: "2026-11-03T09:00:00Z" }), item({ id: "c", title: "تقرير تجريبي", created_at: "2026-11-02T09:00:00Z" })];
    const groups = groupMaterials(items, "coverage");
    expect(groups.map(g => g.items.map(i => i.id))).toEqual([["b", "a"], ["c"]]);
    expect(groupMaterials(items, "type")).toHaveLength(1);
  });
  it("filters by video, photos and urgent, and counts what needs action", () => {
    const photo = item({ id: "p", material_types: ["photos"] }), urgent = item({ id: "u", priority: "urgent" }), changes = item({ id: "c", editorial_state: "needs_changes" });
    expect([photo, urgent].filter(x => matchesFilter(x, "photos")).map(x => x.id)).toEqual(["p"]);
    expect([photo, urgent].filter(x => matchesFilter(x, "video")).map(x => x.id)).toEqual(["u"]);
    expect([photo, urgent].filter(x => matchesFilter(x, "urgent")).map(x => x.id)).toEqual(["u"]);
    expect(needsAction(changes)).toBe(true); expect(mineCounts([photo, changes]).action).toBe(1);
  });
  it("asks no cloud thumbnail for a sensitive or unknown-sensitivity material, and only a verified thumbnail otherwise", () => {
    const thumb = { ...material().files[0], id: "30000000-0000-4000-8000-000000000009", kind: "thumbnail" as const, state: "verified" as const };
    expect(cardMedia(item({ sensitivity: { minors: true, injured: false, graphic: false }, files: [thumb] })).kind).toBe("sensitive");
    expect(cardMedia(item({ sensitivity: undefined as never, files: [thumb] })).kind).toBe("sensitive");
    expect(cardMedia(item({ sensitivity: { minors: false, injured: false, graphic: false }, files: [thumb] })).kind).toBe("thumbnail");
    expect(cardMedia(item({ sensitivity: { minors: false, injured: false, graphic: false }, files: [{ ...thumb, state: "pending" as never }] })).kind).toBe("icon");
  });
  it("says today and yesterday by the calendar, and writes durations as m:ss", () => {
    const now = new Date(2026, 10, 3, 9, 0);
    expect(dayKind(new Date(2026, 10, 3, 0, 5).toISOString(), now)).toBe("today");
    expect(dayKind(new Date(2026, 10, 2, 23, 55).toISOString(), now)).toBe("yesterday");
    expect(dayKind(new Date(2026, 10, 1, 12, 0).toISOString(), now)).toBe("date");
    expect(durationLabel(102000)).toBe("1:42"); expect(durationLabel(3723000)).toBe("1:02:03");
  });
});

describe("notifications: the event type passes from the closed Outbox list only (W10 store tab, ADR 0103)", () => {
  it("matches outbox-event.json exactly", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../contracts/schemas/outbox-event.json", import.meta.url), "utf8"));
    expect([...notificationTypes].sort()).toEqual([...schema.properties.type.enum].sort());
  });
  it("keeps a known type, blanks anything else, and still drops the free-text title", () => {
    expect(knownType("order.status_changed")).toBe("order.status_changed"); expect(knownType("never-display-canary")).toBe(""); expect(knownType(7)).toBe("");
    const safe = safeNotification(notice({ type: "license.issued", title: "never-display-canary" }));
    expect(safe.type).toBe("license.issued"); expect(safe.title).toBe("");
  });
  it("puts orders and licences in the store tab, tasks in mine, and says each kind with an icon and a word", () => {
    expect(inTab(notice({ type: "order.status_changed" }), "store")).toBe(true); expect(inTab(notice({ type: "material.created" }), "store")).toBe(false);
    expect(inTab(notice({ assignment_id: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c" }), "mine")).toBe(true);
    expect(notificationKind(notice({ priority: "urgent", type: "order.status_changed" })).word).toBe("urgent");
    expect(notificationKind(notice({ type: "license.revoked" }))).toEqual({ word: "store", icon: "store" });
    expect(notificationKind(notice({ type: "payout.status_changed" })).word).toBe("money");
    for (const word of ["urgent", "task", "store", "money", "upload", "update"] as const) { expect(ar.shell.bell.kinds[word]).toBeTruthy(); expect(en.shell.bell.kinds[word]).toBeTruthy(); }
  });
});

describe("ready archive (W9) and its no-results state (E4)", () => {
  it("filters the loaded pages by search, period and governorate, with governorate chips from the data", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const items = [item({ id: "a", title: "عنوان تجريبي", governorate: "غزة", updated_at: "2026-11-03T10:00:00Z" }), item({ id: "b", title: "تقرير", governorate: "رفح", updated_at: "2026-10-01T10:00:00Z" }), item({ id: "c", title: "مقابلة", governorate: "غزة", updated_at: "2026-10-30T10:00:00Z" })];
    expect(filterArchive(items, noFilters, now)).toHaveLength(3);
    expect(filterArchive(items, { ...noFilters, period: "week" }, now).map(i => i.id)).toEqual(["a", "c"]);
    expect(filterArchive(items, { ...noFilters, governorate: "رفح" }, now).map(i => i.id)).toEqual(["b"]);
    expect(filterArchive(items, { ...noFilters, q: "تجريبي" }, now).map(i => i.id)).toEqual(["a"]);
    expect(archiveGovernorates(items)).toEqual(["غزة", "رفح"]);
  });
  it("lets the BFF pass the contract's sort values only", () => {
    expect(materialQuery(new URLSearchParams("editorial_state=published&sort=updated_desc&limit=60"))).toEqual({ editorial_state: "published", sort: "updated_desc", limit: 60 });
    expect(() => materialQuery(new URLSearchParams("sort=title_asc"))).toThrow();
  });
});

describe("invite acceptance (S5): contract rules before anything leaves the browser", () => {
  it("validates the token, password and code by the contract, and trims a pasted token", () => {
    const token = "synthetic-invite-token-member-0001";
    expect(inviteInput({ reset_token: `  ${token}\n`, new_password: "twelve-chars" })).toEqual({ reset_token: token, new_password: "twelve-chars" });
    expect(inviteInput({ reset_token: token, new_password: "short" })).toBeNull();
    expect(inviteInput({ reset_token: "short", new_password: "twelve-chars" })).toBeNull();
    expect(inviteInput({ reset_token: `${token}\u0007`, new_password: "twelve-chars" })).toBeNull();
    expect(totpInput({ totp_code: "123456" })).toEqual({ totp_code: "123456" }); expect(totpInput({ totp_code: "12345a" })).toBeNull();
  });
  it("reads the token from the fragment only, and passes a TOTP enrollment of the contract's shape only", () => {
    expect(tokenFromHash("#token=synthetic-invite-token-member-0001")).toBe("synthetic-invite-token-member-0001"); expect(tokenFromHash("#token=x")).toBeNull();
    expect(safeEnrollment({ secret_base32: "AAAABBBBCCCCDDDD", otpauth_uri: "otpauth://totp/S:x?secret=AAAABBBBCCCCDDDD" })).not.toBeNull();
    expect(safeEnrollment({ secret_base32: "AAAABBBBCCCCDDDD", otpauth_uri: "javascript:alert(1)" })).toBeNull();
    expect(safeEnrollment({ secret_base32: "lowercase", otpauth_uri: "otpauth://totp/x" })).toBeNull();
    expect(groupSecret("AAAABBBBCCCCDDDD")).toBe("AAAA BBBB CCCC DDDD");
  });
  const post = (path: string, body: unknown, cookie?: string) => new NextRequest(`${config.origin}/api/bff/${path}`, { method: "POST", body: JSON.stringify(body), headers: { origin: config.origin, "x-requested-with": "post-history-web", "content-type": "application/json", ...(cookie ? { cookie: `${config.cookieName}=${cookie}` } : {}) } });
  it("completes the invite without a session, keeps the restricted tokens behind the cookie, then rotates the cookie on TOTP confirm", async () => {
    const store = new MemoryStore(), seen: Request[] = [];
    const fetch = (async (input: Request) => {
      seen.push(input);
      if (input.url.endsWith("/auth/recovery/complete")) return Response.json({ session: tokens(), totp_enrollment: { secret_base32: "AAAABBBBCCCCDDDD", otpauth_uri: "otpauth://totp/S:x?secret=AAAABBBBCCCCDDDD", extra: "never-display-canary" } });
      if (input.url.endsWith("/auth/totp/confirm")) return (await input.clone().json()).totp_code === "123456" ? Response.json(tokens()) : Response.json({ code: "unauthorized" }, { status: 401 });
      return Response.json({}, { status: 404 });
    }) as typeof globalThis.fetch;
    const first = await handle(post("auth/recovery/complete", { reset_token: "synthetic-invite-token-member-0001", new_password: "twelve-chars" }), "auth/recovery/complete", { config, store, fetch });
    expect(first.status).toBe(200);
    const text = await first.text(); expect(text).not.toContain("synthetic-access"); expect(text).not.toContain("never-display-canary"); expect(JSON.parse(text)).toEqual({ totp_enrollment: { secret_base32: "AAAABBBBCCCCDDDD", otpauth_uri: "otpauth://totp/S:x?secret=AAAABBBBCCCCDDDD" } });
    expect(seen[0].headers.get("authorization")).toBeNull();
    const restricted = first.cookies.get(config.cookieName)!.value; expect(store.data.has(restricted)).toBe(true);
    const wrong = await handle(post("auth/totp/confirm", { totp_code: "000000" }, restricted), "auth/totp/confirm", { config, store, fetch });
    expect(wrong.status).toBe(401); expect(await wrong.json()).toEqual({ code: "totp_invalid" }); expect(store.data.has(restricted)).toBe(true);
    const ok = await handle(post("auth/totp/confirm", { totp_code: "123456" }, restricted), "auth/totp/confirm", { config, store, fetch });
    expect(ok.status).toBe(200); const full = ok.cookies.get(config.cookieName)!.value;
    expect(full).not.toBe(restricted); expect(store.data.has(restricted)).toBe(false); expect(store.data.has(full)).toBe(true);
  });
  it("answers one 401 for any refused token and never echoes the token or the password", async () => {
    const fetch = (async () => Response.json({ code: "unauthorized", message: "never-display-canary" }, { status: 401 })) as typeof globalThis.fetch;
    const response = await handle(post("auth/recovery/complete", { reset_token: "synthetic-invite-token-member-0002", new_password: "twelve-chars" }), "auth/recovery/complete", { config, store: new MemoryStore(), fetch });
    expect(response.status).toBe(401); const text = await response.text();
    expect(JSON.parse(text)).toEqual({ code: "invite_invalid" }); expect(text).not.toContain("synthetic-invite-token"); expect(text).not.toContain("twelve-chars");
    const bad = await handle(post("auth/recovery/complete", { reset_token: "short", new_password: "twelve-chars" }), "auth/recovery/complete", { config, store: new MemoryStore(), fetch });
    expect(bad.status).toBe(422);
  });
});

describe("states as a word, an icon and a tone (upload U2, payouts, licence verification)", () => {
  it("maps upload phases onto the eight UI stages", () => {
    const base = { hashed: 0, sent: 0, total: 10, resumed: false };
    expect(uploadStage({ ...base, phase: "uploading" }, false).stage).toBe("offline");
    expect(uploadStage({ ...base, phase: "processing" }).stage).toBe("verifying");
    expect(uploadStage({ ...base, phase: "done", session: { state: "deduplicated" } as never }).stage).toBe("duplicate");
    expect(uploadStage({ ...base, phase: "done", session: { state: "verified" } as never })).toEqual({ stage: "verified", tone: "ok", icon: "check" });
    expect(uploadStage({ ...base, phase: "failed", failure: "checksum_mismatch" }).tone).toBe("danger");
    expect(megabytes(112 * 1048576, "ar")).toBe("112"); expect(megabytes(1572864, "en")).toBe("1.5");
  });
  it("gives payouts and licence states a tone and icon", () => {
    expect(payoutWord("paid").tone).toBe("ok"); expect(payoutWord("rejected").tone).toBe("danger"); expect(payoutWord("requested").tone).toBe("brand");
    expect(verifyWord("active").tone).toBe("ok"); expect(verifyWord("expired").tone).toBe("warn"); expect(verifyWord("revoked").tone).toBe("danger");
  });
});

describe("money and store cards", () => {
  for (const [locale, m] of [["ar", ar], ["en", en]] as const) it(`carries the store's and the admin's fixed trial wording on «أرباحي» (${locale})`, () => {
    const html = renderToStaticMarkup(<SandboxBanner locale={locale} />);
    expect(html).toContain(m.store.cartPage.sandbox); expect(html).toContain(m.money.sandbox);
  });
  it("tells a pending organization what is reviewed and what its admin can do, with no promise of a notification (S6)", () => {
    const html = renderToStaticMarkup(<OrgPending locale="ar" organization={{ status: "pending_verification", seats: 5, active_members: 1 }} canInvite />);
    expect(html).toContain(ar.store.org.pendingTitle); expect(html).toContain(ar.store.org.checkAgreement); expect(html).toContain("1 من 5"); expect(html).toContain('href="/ar/organization"');
    const member = renderToStaticMarkup(<OrgPending locale="en" organization={{ status: "suspended", seats: 5, active_members: 1 }} canInvite={false} />);
    expect(member).toContain(en.store.org.suspendedTitle); expect(member).not.toContain(en.store.org.invite);
  });
});

describe("my materials in one grid", () => {
  const group = (key: string, newest: string, count = 1): MineGroup => ({ key, title: key, type: null, newest, items: Array.from({ length: count }, () => material()) });
  it("sections by time: today, this week, then month by month, however many coverages there are", () => {
    const now = new Date(2026, 10, 11, 15, 0), at = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0).toISOString();
    const groups = [group("a", at(2026, 10, 11)), group("b", at(2026, 10, 11), 4), group("c", at(2026, 10, 8)), group("d", at(2026, 10, 5)), group("e", at(2026, 10, 2)), group("f", at(2026, 9, 20)), group("g", at(2026, 9, 3)), group("h", "not a date")];
    const sections = timeSections(groups, now);
    expect(sections.map(section => [section.kind, section.month, section.groups.map(g => g.key).join("")])).toEqual([["today", null, "ab"], ["week", null, "cd"], ["month", "2026-11", "e"], ["month", "2026-10", "fg"], ["month", null, "h"]]);
    // مئة تغطية بمادة واحدة في الشهر نفسه قسم واحد، لا مئة.
    expect(timeSections(Array.from({ length: 100 }, (_, i) => group(`k${i}`, at(2026, 8, 1 + (i % 28)))), now)).toHaveLength(1);
  });
  it("names a month in the interface language with Latin digits", () => {
    expect(monthName("2026-10", "ar")).toBe("تشرين الأول 2026"); expect(monthName("2026-10", "en")).toBe("October 2026");
  });
});
