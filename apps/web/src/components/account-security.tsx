"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, longDate, messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { cleanText, fill, stripHidden } from "@/lib/admin-text";
import { passkeyLimits, stepUpBody, stepUpProblem, stepUpRefusal, validPasskeyName, type Passkey, type PasskeyChallenge } from "@/lib/passkey-policy";
import { ceremonyFailure, passkeysSupported, registerCeremony } from "@/lib/passkey-client";
import { groupCode, type RecoveryCodes, type RecoveryCodeStatus } from "@/lib/recovery-policy";
import { useMutation } from "@/lib/use-mutation";
import { ConfirmDialog, LengthCounter, ToneBadge } from "./admin-parts";
import { Icon } from "./icon";

type Notice = { tone: "good" | "attention"; text: string } | null;
const still = () => () => {};

/**
 * الأمان (ADR 0107، 0108، 0120): مفاتيح المرور (قائمة وإضافة بإعادة تحقق وإبطال بتأكيد) والرموز الاحتياطية (العدد الباقي، وتوليد عشرة
 * جديدة تبطل السابقة بإعادة التحقق نفسها وتُعرض مرة). لكل حساب بجلسة، طاقمًا أو مشتريًا. كلمة المرور والرموز في ذاكرة المكوّن وحده وتُمحى
 * بعد الاستعمال.
 */
export function AccountSecurity({ locale }: { locale: Locale }) {
  const t = messages[locale].security;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <div className="security-grid">
      <PasskeysCard locale={locale} />
      <BackupCodesCard locale={locale} />
    </div>
  </>;
}

/** إعادة التحقق (ADR 0107، 0117): كلمة المرور ورمز تطبيق المصادقة، الحقلان أنفسهما قبل إضافة مفتاح المرور وقبل توليد الرموز الاحتياطية. */
export function StepUpFields({ locale, password, code, checked, onPassword, onCode }: { locale: Locale; password: string; code: string; checked: boolean; onPassword: (value: string) => void; onCode: (value: string) => void }) {
  const t = messages[locale].security, problem = checked ? stepUpProblem(password, code) : null;
  return <>
    <label>{t.password}<input name="password" type="password" dir="ltr" autoComplete="current-password" autoFocus maxLength={passkeyLimits.password} value={password} aria-invalid={problem === "passwordRequired" || undefined} onChange={event => onPassword(event.target.value)} /></label>
    <label>{t.totp}<input name="totp" inputMode="numeric" dir="ltr" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} aria-invalid={problem === "totpInvalid" || undefined} onChange={event => onCode(event.target.value.replace(/\D/g, ""))} /></label>
  </>;
}

function PasskeysCard({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.security, supported = useSyncExternalStore(still, passkeysSupported, () => false), mutation = useMutation();
  const [items, setItems] = useState<Passkey[] | null>(null), [state, setState] = useState<"loading" | "ready" | "failed" | "off">("loading"), [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false), [password, setPassword] = useState(""), [code, setCode] = useState(""), [name, setName] = useState(""), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState<Notice>(null), [revoking, setRevoking] = useState<Passkey | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/me/passkeys", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.response.status === 404) { setState("off"); return; }
      setItems(dataOrThrow(result).items); setState("ready");
    }).catch(() => { if (!controller.signal.aborted) setState("failed"); });
    return () => controller.abort();
  }, [attempt]);
  const label = cleanText(name), nameOk = !label || validPasskeyName(label), full = (items?.length ?? 0) >= passkeyLimits.max;
  function close() { setAdding(false); setPassword(""); setCode(""); setName(""); setChecked(false); setError(""); }
  async function add(event: React.FormEvent) {
    event.preventDefault(); setChecked(true); setError(""); setNotice(null);
    const problem = stepUpProblem(password, code);
    if (problem) { setError(t[problem]); return; }
    if (!nameOk) return;
    setBusy(true);
    try {
      const options = await browserApi().POST("/auth/passkeys/registration-options", { body: stepUpBody(password, code) });
      const refusal = stepUpRefusal(options.response.status, (options.error as { code?: string } | undefined)?.code);
      if (refusal === "session") { window.dispatchEvent(new Event("session-revoked")); setError(m.revoked); return; }
      if (refusal) { setError(t[refusal]); return; }
      if (options.response.status === 404) { close(); setState("off"); return; }
      if (options.response.status === 409) { setError(t.limit); return; }
      const challenge = dataOrThrow(options) as PasskeyChallenge;
      setPassword(""); setCode("");
      let credential;
      try { credential = await registerCeremony(challenge); }
      catch (reason) { const kind = ceremonyFailure(reason); setError(kind === "cancelled" ? t.cancelled : kind === "exists" ? t.exists : t.failed); return; }
      const box: { status?: number; code?: string; passkey?: Passkey } = {};
      const ok = await mutation.run(JSON.stringify(["passkey", challenge.challenge_id]), async header => {
        const result = await browserApi().POST("/me/passkeys", { params: { header }, body: { challenge_id: challenge.challenge_id, credential, ...(label ? { name: label } : {}) } });
        box.status = result.response.status; box.code = (result.error as { code?: string } | undefined)?.code; box.passkey = result.data; return result;
      });
      if (ok && box.passkey) { const added = box.passkey; setItems(list => [...(list ?? []).filter(item => item.id !== added.id), added]); close(); setNotice({ tone: "good", text: t.added }); return; }
      mutation.clearStatus();
      setError(box.status === 410 ? t.expired : box.status === 409 ? (box.code === "passkey_limit_reached" ? t.limit : t.exists) : t.failed);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!revoking) return;
    const target = revoking, box: { status?: number } = {};
    const ok = await mutation.run(JSON.stringify(["revoke-passkey", target.id]), async header => { const result = await browserApi().DELETE("/me/passkeys/{passkey_id}", { params: { path: { passkey_id: target.id }, header } }); box.status = result.response.status; return result; });
    // 404: أُبطل من قبل (تبويب آخر)؛ النتيجة نفسها.
    if (ok || box.status === 404) { mutation.clearStatus(); setRevoking(null); setItems(list => (list ?? []).filter(item => item.id !== target.id)); setNotice({ tone: "good", text: t.revoked }); }
  }
  return <section className="card security-card" aria-labelledby="passkeys-title" data-testid="passkeys">
    <h2 id="passkeys-title"><Icon name="key" />{t.passkeysTitle}</h2>
    <p className="muted">{t.passkeysLead}</p>
    {notice && <p className={`notice ${notice.tone}`} role="status" data-testid="passkeys-notice">{notice.text}</p>}
    {state === "loading" && <p className="muted" role="status">{m.loading}</p>}
    {state === "failed" && <p className="notice error" role="alert">{m.error} <button type="button" className="quiet small" onClick={() => { setState("loading"); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    {state === "off" && <p className="notice" data-testid="passkeys-off">{t.unavailable}</p>}
    {state === "ready" && items && <>
      {items.length ? <ul className="passkey-list">{items.map(item => <li key={item.id}><article aria-label={item.name ?? t.unnamed}>
        <div><strong><bdi>{item.name ?? t.unnamed}</bdi></strong>
          <p className="caption">{[fill(t.created, { date: longDate(item.created_at, locale) }), item.last_used_at ? fill(t.lastUsed, { date: formatDate(item.last_used_at, locale) }) : t.neverUsed].join(" · ")}</p></div>
        <ToneBadge tone={item.multi_device ? "brand" : "muted"} icon={item.multi_device ? "globe" : "lock"}>{item.multi_device ? t.synced : t.deviceOnly}</ToneBadge>
        <button type="button" className="secondary small" disabled={mutation.busy} onClick={() => { mutation.clearStatus(); setNotice(null); setRevoking(item); }}>{t.revoke}</button>
      </article></li>)}</ul> : <p className="muted" data-testid="passkeys-empty">{t.empty}</p>}
      {!supported ? <p className="notice" data-testid="passkeys-unsupported">{t.unsupported}</p> : full ? <p className="notice">{t.limit}</p>
        : adding ? <form className="invite-form security-form" noValidate onSubmit={event => void add(event)} data-testid="passkey-form">
          <h3>{t.stepUpTitle}</h3><p className="caption">{t.stepUpLead}</p>
          <StepUpFields locale={locale} password={password} code={code} checked={checked} onPassword={setPassword} onCode={setCode} />
          <label>{t.name}<input name="passkey-name" maxLength={passkeyLimits.name * 2} value={name} aria-invalid={checked && !nameOk || undefined} aria-describedby="passkey-name-help" onChange={event => setName(stripHidden(event.target.value))} /></label>
          <small id="passkey-name-help" className="field-help">{checked && !nameOk ? t.nameInvalid : t.nameHelp} <LengthCounter value={label} max={passkeyLimits.name} /></small>
          {busy && <p className="caption" role="status">{t.waiting}</p>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={close}>{m.cancel}</button><button disabled={busy}>{busy ? m.review.saving : t.continue}</button></div>
        </form> : <div className="actions"><button type="button" data-testid="add-passkey" onClick={() => { setNotice(null); setAdding(true); }}><Icon name="plus" />{t.add}</button></div>}
    </>}
    {revoking && <ConfirmDialog locale={locale} testId="confirm-revoke-passkey" title={t.revokeTitle} confirm={t.revoke} busy={mutation.busy} status={mutation.status} danger onConfirm={() => void revoke()} onCancel={() => setRevoking(null)}>
      <p>{fill(t.revokeEffect, { name: revoking.name ?? t.unnamed })}</p>
    </ConfirmDialog>}
  </section>;
}

function BackupCodesCard({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.security;
  const [status, setStatus] = useState<RecoveryCodeStatus | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false), [password, setPassword] = useState(""), [code, setCode] = useState(""), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [codes, setCodes] = useState<RecoveryCodes | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/auth/recovery-codes", { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setStatus(dataOrThrow(result)); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  function close() { setOpen(false); setPassword(""); setCode(""); setChecked(false); setError(""); }
  // إعادة التحقق قبل التوليد (ADR 0117): كلمة المرور ورمز TOTP في الجسم وحدهما، ويُمحيان بعد النجاح أو الإلغاء. بلا مفتاح منع تكرار
  // (مسار `/auth/*`): الرموز لا تُحفظ في جدول المفاتيح، فإعادة المحاولة بعد النجاح تولّد مجموعة أخرى تبطل ما قبلها.
  async function generate(event: React.FormEvent) {
    event.preventDefault(); setChecked(true); setError("");
    const problem = stepUpProblem(password, code);
    if (problem) { setError(t[problem]); return; }
    setBusy(true);
    try {
      const result = await browserApi().POST("/auth/recovery-codes", { body: stepUpBody(password, code) });
      const refusal = stepUpRefusal(result.response.status, (result.error as { code?: string } | undefined)?.code);
      if (refusal === "session") { window.dispatchEvent(new Event("session-revoked")); setError(m.revoked); return; }
      if (refusal) { setError(t[refusal]); return; }
      if (!result.response.ok || !result.data) { setError(m.error); return; }
      const fresh = result.data;
      close(); setCodes(fresh); setStatus({ remaining: fresh.codes.length, generated_at: fresh.generated_at });
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  const action = status?.generated_at ? t.regenerate : t.generate;
  return <section className="card security-card" aria-labelledby="codes-title" data-testid="backup-codes">
    <h2 id="codes-title"><Icon name="shield" />{t.codesTitle}</h2>
    <p className="muted">{t.codesLead}</p>
    {failed && <p className="notice error" role="alert">{m.error} <button type="button" className="quiet small" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>}
    {!status && !failed && <p className="muted" role="status">{m.loading}</p>}
    {codes ? <div className="one-time-link" data-testid="codes-once">
      <p className="notice" role="status">{t.codesOnce}</p>
      <ol className="backup-code-list mono" dir="ltr">{codes.codes.map(item => <li key={item}>{groupCode(item)}</li>)}</ol>
      <div className="actions"><button type="button" className="secondary" onClick={() => setCodes(null)}>{t.codesDone}</button></div>
    </div> : status && <>
      <p data-testid="codes-status"><strong>{status.generated_at ? plural(status.remaining, t.codesLeft as PluralForms, locale) : t.codesNone}</strong>
        {status.generated_at && <span className="caption"> · {fill(t.codesGenerated, { date: longDate(status.generated_at, locale) })}</span>}</p>
      {open ? <form className="invite-form security-form" noValidate onSubmit={event => void generate(event)} aria-labelledby="codes-form-title" data-testid="codes-form">
        <h3 id="codes-form-title">{t.generateTitle}</h3>
        <p className="notice attention">{t.generateEffect}</p>
        <p className="caption">{t.codesStepUpLead}</p>
        <StepUpFields locale={locale} password={password} code={code} checked={checked} onPassword={setPassword} onCode={setCode} />
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={close}>{m.cancel}</button><button disabled={busy}>{busy ? m.review.saving : action}</button></div>
      </form> : <div className="actions"><button type="button" className={status.generated_at ? "secondary" : undefined} data-testid="generate-codes" onClick={() => { setError(""); setOpen(true); }}>{action}</button></div>}
    </>}
  </section>;
}
