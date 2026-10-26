"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { authPost, browserApi, dataOrThrow, leaveSession } from "@/lib/browser-api";
import { hasRole } from "@/lib/review";
import { catalogRoles } from "./store/store-catalog";
import { uploadRoles } from "@/lib/upload-policy";
import { isBuyer, organizationAdmins } from "@/lib/buyer-policy";
import { commissionReaders } from "@/lib/commission-policy";
import { templateRoles } from "@/lib/license-policy";
import { formReaders } from "@/lib/form-admin";

const UserContext = createContext<Me | null>(null);
export function useUser() { const me = useContext(UserContext); if (!me) throw new Error("Session required"); return me; }

export function SessionBoundary({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const m = messages[locale], pathname = usePathname(), router = useRouter();
  const [me, setMe] = useState<Me | null>(null), [error, setError] = useState(false), [confirmAll, setConfirmAll] = useState(false), [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const logoutPending = useRef(false);
  useEffect(() => {
    let disposed = false, sequence = 0;
    let controller = new AbortController();
    const clear = () => { sequence++; controller.abort(); setMe(null); };
    const revoke = () => { if (!logoutPending.current) { clear(); leaveSession(locale, "revoked"); } };
    const check = async () => {
      clear(); const current = sequence; controller = new AbortController();
      try {
        const data = dataOrThrow(await browserApi().GET("/auth/me", { signal: controller.signal }));
        if (!disposed && current === sequence) { setMe(data); setError(false); }
      } catch { if (!disposed && current === sequence && !controller.signal.aborted) setError(true); }
    };
    const visibility = () => { if (document.visibilityState === "hidden") clear(); else void check(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void check(); };
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("web-session") : null;
    if (channel) channel.onmessage = () => { clear(); void check(); };
    window.addEventListener("session-revoked", revoke);
    window.addEventListener("clear-private-state", clear);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", visibility);
    void check();
    return () => { disposed = true; controller.abort(); channel?.close(); window.removeEventListener("session-revoked", revoke); window.removeEventListener("clear-private-state", clear); window.removeEventListener("pageshow", restored); document.removeEventListener("visibilitychange", visibility); };
  }, [locale, attempt]);

  async function logout(all: boolean) {
    logoutPending.current = true; setBusy(true); setError(false);
    try {
      const result = await authPost("logout", { all_sessions: all });
      if (result.response.ok || result.response.status === 401) { setMe(null); leaveSession(locale, result.response.status === 401 ? "revoked" : "signed-out"); }
      else setError(true);
    } catch { setError(true); }
    finally { logoutPending.current = false; setBusy(false); }
  }
  // حساب المشتري لا يرى صفحات الطاقم: المتجر ومؤسسته وحدهما.
  const buyer = !!me && isBuyer(me), buyerPage = /^\/(ar|en)\/(store|organization)(\/|$)/.test(pathname);
  useEffect(() => { if (buyer && !buyerPage) router.replace(`/${locale}/store`); }, [buyer, buyerPage, locale, router]);
  if (!me || (buyer && !buyerPage)) return <main className="center-state" role="status">{error ? <><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></> : m.loading}</main>;
  return <UserContext.Provider value={me}>
    <a className="skip-link" href="#main-content">{m.skip}</a>
    <header className="site-header"><Link className="brand" href={`/${locale}/${buyer ? "store" : "inbox"}`} prefetch={false}><span className="brand-mark" aria-hidden="true" /><span>{m.brand}<small>{m.product}</small></span></Link>
      <div className="header-actions"><a href={pathname.replace(`/${locale}`, locale === "ar" ? "/en" : "/ar")} lang={locale === "ar" ? "en" : "ar"}>{m.language}</a><button className="quiet" disabled={busy} onClick={() => void logout(false)}>{m.logout}</button></div></header>
    <div className="workspace-shell"><aside className="sidebar">{!buyer && <p className="eyebrow">{m.workspace}</p>}<nav aria-label={m.workspace}>{buyer ? <>
      <Link prefetch={false} className={pathname.includes("/store") && !/\/store\/(cart|orders|licenses)/.test(pathname) ? "active" : ""} href={`/${locale}/store`}>{m.store.title}</Link>
      <Link prefetch={false} className={pathname.includes("/store/licenses") ? "active" : ""} href={`/${locale}/store/licenses`}>{m.licenses.nav}</Link>
      <Link prefetch={false} className={/\/store\/(cart|orders)/.test(pathname) ? "active" : ""} href={`/${locale}/store/cart`}>{m.orders.nav}</Link>
      <Link prefetch={false} className={pathname.endsWith("/organization") ? "active" : ""} href={`/${locale}/organization`}>{m.buyers.myOrganization}</Link>
    </> : <>
      <Link prefetch={false} className={pathname.endsWith("/inbox") ? "active" : ""} href={`/${locale}/inbox`}>{m.inbox}</Link>
      {hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin") && <Link prefetch={false} className={pathname.endsWith("/board") ? "active" : ""} href={`/${locale}/board`}>{m.board.title}</Link>}
      {hasRole(me, "reporter") && <Link prefetch={false} className={pathname.endsWith("/my-materials") ? "active" : ""} href={`/${locale}/my-materials`}>{m.mine.nav}</Link>}
      {hasRole(me, ...uploadRoles) && <Link prefetch={false} className={pathname.endsWith("/upload") ? "active" : ""} href={`/${locale}/upload`}>{m.upload.nav}</Link>}
      {hasRole(me, ...catalogRoles) && <Link prefetch={false} className={pathname.includes("/store") ? "active" : ""} href={`/${locale}/store`}>{m.store.title}</Link>}
      <Link prefetch={false} className={pathname.endsWith("/form-preview") ? "active" : ""} href={`/${locale}/form-preview`}>{m.formPreview}</Link>
      {hasRole(me, ...formReaders) && <Link prefetch={false} className={pathname.endsWith("/forms") ? "active" : ""} href={`/${locale}/forms`}>{m.formsAdmin.title}</Link>}
      <Link prefetch={false} className={pathname.endsWith("/notifications") ? "active" : ""} href={`/${locale}/notifications`}>{m.notice.title}</Link>
      {hasRole(me, "system_admin", "editor_in_chief") && <Link prefetch={false} className={pathname.endsWith("/notification-rules") ? "active" : ""} href={`/${locale}/notification-rules`}>{m.rules.title}</Link>}
      {hasRole(me, ...templateRoles) && <Link prefetch={false} className={pathname.endsWith("/license-templates") ? "active" : ""} href={`/${locale}/license-templates`}>{m.templates.nav}</Link>}
      {hasRole(me, "system_admin", "finance", "rights_officer") && <Link prefetch={false} className={pathname.includes("/store/licenses") ? "active" : ""} href={`/${locale}/store/licenses`}>{m.licenses.nav}</Link>}
      {hasRole(me, ...organizationAdmins) && <Link prefetch={false} className={pathname.endsWith("/buyer-organizations") ? "active" : ""} href={`/${locale}/buyer-organizations`}>{m.buyers.nav}</Link>}
      {hasRole(me, ...commissionReaders) && <Link prefetch={false} className={pathname.endsWith("/commission-rules") ? "active" : ""} href={`/${locale}/commission-rules`}>{m.commission.nav}</Link>}
      {hasRole(me, "system_admin") && <Link prefetch={false} className={pathname.endsWith("/admin") ? "active" : ""} href={`/${locale}/admin`}>{m.admin.title}</Link>}
    </>}</nav>{!buyer && <p className="scope-note">{m.readOnly}</p>}<button className="quiet danger-link" onClick={() => setConfirmAll(true)}>{m.logoutAll}</button></aside>
    <main id="main-content" className="main-content">{error && <p className="notice error" role="alert">{m.error}</p>}{children}</main></div>
    {confirmAll && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setConfirmAll(false)} aria-labelledby="logout-title"><h2 id="logout-title">{m.logoutAll}</h2><p>{m.logoutAllWarning}</p><div className="actions"><button autoFocus className="secondary" disabled={busy} onClick={() => setConfirmAll(false)}>{m.cancel}</button><button className="danger" disabled={busy} onClick={() => void logout(true)}>{m.confirm}</button></div></dialog>}
  </UserContext.Provider>;
}
