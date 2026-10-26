import type { components } from "@/generated/schema";

// طابور تعارض دعوات المشترين (#331، #361)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type InviteConflict = components["schemas"]["BuyerInviteConflict"];
export type InviteConflictResolve = components["schemas"]["BuyerInviteConflictResolve"];
type Role = components["schemas"]["RoleName"];
export const conflictRoles = ["system_admin"] as const satisfies readonly Role[];
export const conflictStates = ["pending", "suspended", "dismissed"] as const satisfies readonly InviteConflict["state"][];
export const resolveStates = ["suspended", "dismissed"] as const satisfies readonly InviteConflictResolve["state"][];

/** الانتقالات المسموحة في العقد: من المعلّق إلى الحالتين، ومن الموقوف إلى الإغلاق. الخادم هو الحكم النهائي. */
export const nextStates = (state: InviteConflict["state"]): readonly InviteConflictResolve["state"][] => state === "pending" ? resolveStates : state === "suspended" ? ["dismissed"] : [];

/** الحسم بالحالة ورمز TOTP حاضر وحدهما؛ لا نص حر. الرمز يمر إلى الخادم ولا يُحفظ ولا يُسجَّل. */
export function conflictResolve(body: Record<string, unknown>): InviteConflictResolve | null {
  if (Object.keys(body).sort().join() !== "state,totp_code") return null;
  if (!(resolveStates as readonly unknown[]).includes(body.state) || typeof body.totp_code !== "string" || !/^[0-9]{6}$/.test(body.totp_code)) return null;
  return { state: body.state as InviteConflictResolve["state"], totp_code: body.totp_code };
}
/** التعارض للمتصفح بقائمة بيضاء؛ لمدير النظام وحده. */
export function safeConflict(c: InviteConflict): InviteConflict {
  return { id: c.id, organization_id: c.organization_id, email: c.email, existing_user_id: c.existing_user_id, role: c.role, state: c.state, invited_by: c.invited_by, invite_expires_at: c.invite_expires_at, created_at: c.created_at, resolved_at: c.resolved_at ?? null, resolved_by: c.resolved_by ?? null };
}
