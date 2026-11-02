"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { authPost, browserApi, dataOrThrow, leaveSession } from "@/lib/browser-api";
import { isBuyer } from "@/lib/buyer-policy";
import { hasRole } from "@/lib/review";
import { AccountActions, BottomBar, ShellState, ShellTopBar, Sidebar, useInboxBadge } from "./app-shell";
import { navItems } from "./workspace-nav";

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
  if (!me || (buyer && !buyerPage)) return <main className="center-state" role="status">{error ? <><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></> : <><span className="skeleton block" aria-hidden="true" />{m.loading}</>}</main>;
  const items = navItems(me, locale, pathname), inboxHref = `/${locale}/${buyer ? "store" : "inbox"}`;
  const account = <AccountActions me={me} locale={locale} languageHref={pathname.replace(`/${locale}`, locale === "ar" ? "/en" : "/ar")} busy={busy} logout={() => void logout(false)} logoutAll={() => setConfirmAll(true)} />;
  // هيكل v2 (W1، M1، T1): الشريط الجانبي في جهة البداية، والشريط العلوي فوق المحتوى، والشريط السفلي على الجوال.
  // المشتري بلا شريط جانبي ولا سفلي (M4)، ووجه المتجر داكن صراحةً كما في إطارات S (`data-mode`).
  return <UserContext.Provider value={me}><ShellState>{badge => <>
    <a className="skip-link" href="#main-content">{m.skip}</a>
    <div className={`app-shell${buyer ? " buyer" : ""}`} data-mode={buyer ? "dark" : undefined}>
      {!buyer && <Sidebar items={items} locale={locale} brandHref={inboxHref} badge={badge} />}
      <div className="app-main">
        <ShellTopBar me={me} locale={locale} buyer={buyer} items={items} inboxHref={inboxHref} account={account} />
        <main id="main-content" className="main-content">{error && <p className="notice error" role="alert">{m.error}</p>}{!buyer && <UrgentBadge me={me} skip={/^\/(ar|en)\/inbox(\/|$)/.test(pathname)} />}{children}</main>
      </div>
      {!buyer && <BottomBar items={items} locale={locale} badge={badge} account={account} />}
    </div>
    {confirmAll && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setConfirmAll(false)} aria-labelledby="logout-title"><h2 id="logout-title">{m.logoutAll}</h2><p>{m.logoutAllWarning}</p><div className="actions"><button autoFocus className="secondary" disabled={busy} onClick={() => setConfirmAll(false)}>{m.cancel}</button><button className="danger" disabled={busy} onClick={() => void logout(true)}>{m.confirm}</button></div></dialog>}
  </>}</ShellState></UserContext.Provider>;
}

/**
 * عدّاد بند الوارد: العاجل المفتوح من لقطة غرفة الأخبار كل 60 ثانية لأدوار اللوحة وحدها. صفحة الوارد تستطلع اللقطة نفسها كل 5 ثوانٍ
 * وتحدّث العدّاد منها، فلا يستطلع الهيكل هناك (`skip`)، كي لا يعمل مستطلعان لنقطة واحدة.
 */
function UrgentBadge({ me, skip }: { me: Me; skip: boolean }) {
  const set = useInboxBadge(), allowed = hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
  useEffect(() => {
    if (!allowed || skip) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal })); if (!controller.signal.aborted) set(data.urgent_open); } catch { /* يبقى بآخر قيمة */ } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 60000); } }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [allowed, skip, set]);
  return null;
}
