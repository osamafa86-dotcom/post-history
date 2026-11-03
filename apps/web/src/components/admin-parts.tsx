"use client";
import { useEffect, useState } from "react";
import { messages, type Locale } from "@/lib/i18n";
import { initialsOf } from "@/lib/admin-text";
import { ActionStatus } from "./action-status";
import { Icon, type IconName } from "./icon";

/** الصورة الرمزية (`Web/Avatar`) بحرفين من اسم العمل وحده؛ زخرفية لأن الاسم مكتوب بجانبها. */
export function Avatar({ name, fallback }: { name: string | null; fallback: string }) {
  return <span className="avatar-chip" aria-hidden="true">{initialsOf(name, fallback)}</span>;
}

/** شارة بأيقونة وكلمة ولون معًا؛ لا تُقال حالة باللون وحده (design-system-v2.md). */
export function ToneBadge({ tone, icon, children, testId }: { tone: "ok" | "warn" | "muted" | "brand" | "danger"; icon: IconName; children: React.ReactNode; testId?: string }) {
  return <span className={`badge state ${tone}`} data-testid={testId}><Icon name={icon} size={14} />{children}</span>;
}

/** قيمة تتأخر عن الكتابة، فلا يُرسل البحث مع كل حرف. */
export function useDebounced<T>(value: T, ms = 300) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return current;
}

/** زمن نسبي بأرقام لاتينية («قبل 4 دقائق»، «أمس»، «الآن»). */
export function relativeTime(value: string | null, locale: Locale, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const seconds = Math.round((Date.parse(value) - now) / 1000), abs = Math.abs(seconds);
  const [unit, size] = abs < 60 ? ["second", 1] as const : abs < 3600 ? ["minute", 60] as const : abs < 86400 ? ["hour", 3600] as const : abs < 2592000 ? ["day", 86400] as const : abs < 31536000 ? ["month", 2592000] as const : ["year", 31536000] as const;
  const format = new Intl.RelativeTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
  return unit === "second" ? format.format(0, "second") : format.format(Math.round(seconds / size), unit);
}

/**
 * تأكيد الفعل الذي يغيّر شيئًا لا يُرجَع بنقرة (الدمج وإعادة التسمية والحالة والصلاحيات والتفعيل): يقول الأثر بكلماته قبل التنفيذ،
 * و«إلغاء» هو التركيز الأول، وEscape لا يغلقه أثناء الطلب.
 */
export function ConfirmDialog({ title, children, confirm, busy, confirmDisabled, status, locale, danger, onConfirm, onCancel, testId }: { title: string; children: React.ReactNode; confirm: string; busy: boolean; confirmDisabled?: boolean; status: number; locale: Locale; danger?: boolean; onConfirm: () => void; onCancel: () => void; testId?: string }) {
  const m = messages[locale];
  return <dialog className="modal confirm-dialog" data-testid={testId} ref={node => { if (node && !node.open) node.showModal(); }} aria-labelledby="confirm-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="confirm-dialog-title">{title}</h2>
    <div className="confirm-body">{children}</div>
    <ActionStatus status={status === 200 ? 0 : status} locale={locale} />
    <div className="actions"><button type="button" autoFocus className="secondary" disabled={busy} onClick={onCancel}>{m.cancel}</button><button type="button" className={danger ? "danger" : undefined} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? m.review.saving : confirm}</button></div>
  </dialog>;
}

/** عدّاد الطول بنقاط الترميز («12/40»)، بلون الخطر فوق الحد. */
export function LengthCounter({ value, max, id }: { value: string; max: number; id?: string }) {
  const length = Array.from(value).length;
  return <small id={id} className={`length-counter${length > max ? " over" : ""}`} dir="ltr">{length}/{max}</small>;
}
