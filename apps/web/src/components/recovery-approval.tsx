"use client";
import { useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { stripHidden } from "@/lib/admin-text";
import { approvalInput, recoveryApprovers, recoveryLimits, resetLinkFor } from "@/lib/recovery-policy";
import { useUser } from "./session-boundary";
import { NoAccess } from "./empty-state";
import { ConfirmDialog, LengthCounter } from "./admin-parts";
import { OneTimeLink } from "./one-time-link";

type Outcome = "approved" | "delivered" | null;

/**
 * اعتماد طلب استعادة (ADR 0107، 0108): يصل إليه المشرف من تنبيه الطلب. يكتب كيف تحقق من الهوية خارج النظام، ويؤكد بأثر الاعتماد، فيرى رابط
 * إعادة التعيين مرة واحدة ليسلّمه بيده. بلا مفتاح منع تكرار (مسار `/auth/*`)؛ إعادة الاعتماد `409` ولا تعيد الرمز، فلا يُعرض مرتين.
 * لا قراءة لطلب الاستعادة في العقد، فالصفحة تعرض بداية معرّفه وحدها.
 */
export function RecoveryApproval({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], t = m.recovery.approve, me = useUser(), allowed = hasRole(me, ...recoveryApprovers);
  const [note, setNote] = useState(""), [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [issued, setIssued] = useState<{ link: string; expires: string | null } | null>(null), [outcome, setOutcome] = useState<Outcome>(null), [closed, setClosed] = useState(!uuid.test(id));
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  const input = approvalInput({ verification_note: note });
  async function approve() {
    if (!input) return;
    setBusy(true); setError("");
    try {
      const result = await browserApi().POST("/auth/recovery/{id}/approve", { params: { path: { id } }, body: input });
      const status = result.response.status, code = (result.error as { code?: string } | undefined)?.code;
      if (status === 401) { window.dispatchEvent(new Event("session-revoked")); return; }
      if (result.response.ok && result.data) {
        setConfirming(false); setNote(""); setClosed(true);
        if (result.data.reset_token) setIssued({ link: resetLinkFor(window.location.origin, locale, result.data.reset_token), expires: result.data.reset_token_expires_at ?? null });
        else setOutcome("delivered");
        return;
      }
      setConfirming(false);
      if ([403, 404, 409].includes(status)) setClosed(true);
      setError(status === 409 ? t.conflict : status === 403 ? (code === "admin_quorum_required" ? t.adminQuorum : t.forbidden) : status === 404 ? t.notFound : status === 422 ? m.review.invalid : m.error);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <section className="card recovery-approval" aria-labelledby="approval-request" data-testid="recovery-approval">
      <p id="approval-request" className="caption">{t.request}: <span className="mono" dir="ltr">{uuid.test(id) ? id.slice(0, 8) : "—"}</span></p>
      {!uuid.test(id) && <p className="notice error" role="alert">{t.notFound}</p>}
      {error && <p className="notice error" role="alert" data-testid="approval-error">{error}</p>}
      {issued ? <OneTimeLink link={issued.link} expiresAt={issued.expires} locale={locale} testId="approval-reset-link" onDone={() => { setIssued(null); setOutcome("approved"); }} />
        : outcome ? <p className="notice good" role="status" data-testid="approval-done">{outcome === "delivered" ? t.delivered : t.approved}</p>
        : !closed && <form className="invite-form" noValidate onSubmit={event => { event.preventDefault(); if (input) setConfirming(true); }}>
          <label>{t.note}<textarea name="verification-note" rows={3} maxLength={recoveryLimits.note * 2} value={note} aria-describedby="approval-note-help" onChange={event => setNote(stripHidden(event.target.value))} /></label>
          <small id="approval-note-help" className="field-help">{t.noteHelp} <LengthCounter value={note.trim()} max={recoveryLimits.note} /></small>
          <div className="actions"><button data-testid="approve-recovery" disabled={!input || busy}>{t.submit}</button></div>
        </form>}
    </section>
    {confirming && <ConfirmDialog locale={locale} testId="confirm-approval" title={t.confirmTitle} confirm={t.confirm} busy={busy} status={0} danger onConfirm={() => void approve()} onCancel={() => setConfirming(false)}>
      <p>{t.confirmEffect}</p>
    </ConfirmDialog>}
  </>;
}
