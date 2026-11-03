"use client";
import { useRef, useState } from "react";
import { humanDuration, longDate, messages, shortTime, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { canAssign, dueLabel, type AssignmentState, type MaterialAssignment } from "@/lib/assignment-policy";
import { AssignDialog } from "./assign-dialog";
import { useUser } from "./session-boundary";
import { Icon, type IconName } from "./icon";

/** الموعد بكلمة ووقت (W5، M3، W6): «متأخرة ساعة» بلون الخطر، و«خلال 18 دقيقة» و«اليوم 18:00» والتاريخ. لا لون وحده. */
export function DueText({ task, now, locale }: { task: Pick<MaterialAssignment, "due_at" | "overdue" | "state">; now: number; locale: Locale }) {
  const t = messages[locale].tasks.due, due = dueLabel(task, now);
  const text = due.kind === "overdue" ? t.overdue.replace("{time}", humanDuration(due.ms, locale)) : due.kind === "soon" ? t.soon.replace("{time}", humanDuration(due.ms, locale))
    : due.kind === "today" ? t.today.replace("{time}", shortTime(due.at)) : (due.kind === "closed" ? t.closed : t.later).replace("{date}", longDate(due.at, locale));
  return <span className={`task-due ${due.kind}`} data-testid="task-due">{due.kind === "overdue" ? <Icon name="alert" size={14} /> : <Icon name="clock" size={14} />}<bdi>{text}</bdi></span>;
}

const look: Record<AssignmentState, { tone: string; icon: IconName }> = {
  assigned: { tone: "muted", icon: "clock" }, acknowledged: { tone: "brand", icon: "check" }, in_progress: { tone: "warn", icon: "pencil" }, done: { tone: "ok", icon: "check" }, returned: { tone: "danger", icon: "x" },
};
/** حالة المهمة شارةً بأيقونة وكلمة؛ وهي غير الحالات الثلاث للمادة ولا تحلّ محلّ أيٍّ منها. */
export function TaskState({ state, locale }: { state: AssignmentState; locale: Locale }) {
  const { tone, icon } = look[state] ?? look.assigned;
  return <span className={`badge state ${tone}`} data-testid="task-state" data-state={state}><Icon name={icon} size={14} />{messages[locale].tasks.state[state]}</span>;
}

/** «حوّل للمونتير» (W1 وW2 وM2) لمن يملك الإسناد على مادة مقبولة للإنتاج؛ يفتح حوار W3. */
export function AssignButton({ locale, material, compact, disabled, onAssigned }: { locale: Locale; material: Pick<Material, "id" | "title" | "priority" | "files" | "editorial_state">; compact?: boolean; disabled?: boolean; onAssigned: (task: MaterialAssignment, name: string) => void }) {
  const t = messages[locale].assign, me = useUser(), [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
  if (!canAssign(me, material)) return null;
  return <>
    <button ref={opener} type="button" className={compact ? "secondary small" : "secondary"} disabled={disabled} onClick={() => setOpen(true)} aria-label={compact ? `${t.action}: ${material.title}` : undefined} data-testid="assign-open"><Icon name="tasks" size={16} />{compact ? t.rowAction : t.action}</button>
    {open && <AssignDialog locale={locale} material={material} onClose={() => { setOpen(false); opener.current?.focus(); }} onAssigned={onAssigned} />}
  </>;
}
