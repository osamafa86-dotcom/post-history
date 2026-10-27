"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { authPost, browserApi, dataOrThrow, leaveSession } from "@/lib/browser-api";
import { isBuyer } from "@/lib/buyer-policy";
import { TopBar } from "./top-bar";
import { navItems, userLine } from "./workspace-nav";

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
    <TopBar variant="workspace" locale={locale} brandHref={`/${locale}/${buyer ? "store" : "inbox"}`} items={navItems(me, locale, pathname)} navLabel={m.workspace}>
      <span className="topbar-user" data-testid="topbar-user">{userLine(me, locale)}</span>
      <a href={pathname.replace(`/${locale}`, locale === "ar" ? "/en" : "/ar")} lang={locale === "ar" ? "en" : "ar"}>{m.language}</a>
      <button disabled={busy} onClick={() => void logout(false)}>{m.logout}</button>
      <button onClick={() => setConfirmAll(true)}>{m.logoutAll}</button>
    </TopBar>
    <div className="workspace-shell"><main id="main-content" className="main-content">{error && <p className="notice error" role="alert">{m.error}</p>}{children}</main></div>
    {confirmAll && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setConfirmAll(false)} aria-labelledby="logout-title"><h2 id="logout-title">{m.logoutAll}</h2><p>{m.logoutAllWarning}</p><div className="actions"><button autoFocus className="secondary" disabled={busy} onClick={() => setConfirmAll(false)}>{m.cancel}</button><button className="danger" disabled={busy} onClick={() => void logout(true)}>{m.confirm}</button></div></dialog>}
  </UserContext.Provider>;
}
