"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { isOpen, taskReaders, type MaterialAssignment } from "@/lib/assignment-policy";
import { useUser } from "./session-boundary";
import { AssignButton, DueText, TaskState } from "./task-parts";
import { fill } from "./render-dialog";

/**
 * بطاقة «المونتير» في W2 (ADR 0097): المهمة المفتوحة على المادة بحالتها والمونتير وموعدها ورابطها، أو «حوّل للمونتير» لمن يملك الإسناد.
 * لأدوار قراءة المهام وحدها؛ والمادة قبل القبول للإنتاج لا تُسند (الخادم `409 assignment_not_allowed`)، فلا زر لها.
 */
export function AssignmentCard({ locale, material }: { locale: Locale; material: Material }) {
  const m = messages[locale], t = m.assign, me = useUser(), reader = hasRole(me, ...taskReaders);
  const [items, setItems] = useState<MaterialAssignment[] | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [notice, setNotice] = useState(""), [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!reader) return;
    const controller = new AbortController();
    void browserApi().GET("/materials/{id}/assignments", { params: { path: { id: material.id }, query: { limit: 5 } }, signal: controller.signal })
      .then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) { setItems(data.items); setFailed(false); setNow(Date.now()); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [reader, material.id, attempt]);
  if (!reader) return null;
  const open = items?.find(item => isOpen(item.state)), last = items?.[0];
  const name = (task: MaterialAssignment) => task.assignee_name ?? m.task.assigneeUnnamed;
  return <section className="card assignment-card" aria-labelledby="assignment-title" data-testid="assignment-card">
    <h2 id="assignment-title">{t.cardTitle}</h2>
    {failed ? <p className="notice error" role="alert">{m.error}</p> : !items ? <p role="status" className="muted">{m.loading}</p> : open ? <>
      <p className="assignment-current"><TaskState state={open.state} locale={locale} /> <bdi>{name(open)}</bdi></p>
      <p><DueText task={open} now={now} locale={locale} /></p>
      <Link prefetch={false} className="button secondary" href={`/${locale}/tasks/${open.id}`}>{m.tasks.open}</Link>
    </> : <>
      <p className="muted">{hasRole(me, "supervisor", "editor_in_chief") ? t.cardNone : t.cardNoneReader}</p>
      {last && <p className="caption">{fill(t.cardLast, { state: m.tasks.state[last.state], time: formatDate(last.closed_at ?? last.updated_at, locale) })} · <Link prefetch={false} href={`/${locale}/tasks/${last.id}`}>{m.tasks.open}</Link></p>}
      <AssignButton locale={locale} material={material} onAssigned={(_, assignee) => { setNotice(t.done.replace("{name}", assignee)); setAttempt(n => n + 1); }} />
    </>}
    {notice && <p className="notice" role="status">{notice}</p>}
  </section>;
}
