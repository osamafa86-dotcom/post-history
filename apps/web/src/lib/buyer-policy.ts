import type { components } from "@/generated/schema";
import type { Me } from "./types";

// مؤسسات المشترين وأعضاؤها (v0.3، ADR 0025 الجزء 3)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type Organization = components["schemas"]["BuyerOrganization"];
export type OrganizationInput = components["schemas"]["BuyerOrganizationInput"];
export type OrganizationCreate = components["schemas"]["BuyerOrganizationCreate"];
export type Member = components["schemas"]["BuyerMember"];
export type MemberInvite = components["schemas"]["BuyerMemberInvite"];
export type MemberUpdate = components["schemas"]["BuyerMemberUpdate"];
type Role = components["schemas"]["RoleName"];
export const organizationAdmins = ["system_admin", "finance"] as const satisfies readonly Role[];
export const organizationReaders = ["system_admin", "finance", "buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const organizationEditors = ["system_admin", "buyer_admin"] as const satisfies readonly Role[];
export const memberManagers = ["system_admin", "buyer_admin"] as const satisfies readonly Role[];
export const buyerRoles = ["buyer_admin", "buyer_member"] as const satisfies readonly components["schemas"]["BuyerRole"][];
export const organizationStatuses = ["pending_verification", "active", "suspended"] as const satisfies readonly components["schemas"]["BuyerOrganizationStatus"][];
export const memberStatuses = ["active", "suspended"] as const satisfies readonly MemberUpdate["status"][];
export const organizationLimits = { legalName: 200, email: 254, seatsMin: 1, seatsMax: 1000 } as const;

/** حساب مشترٍ: مرتبط بمؤسسة، ولا يرى صفحات الطاقم. */
export const isBuyer = (me: Me) => !!me.organization_id || me.roles.some(role => (buyerRoles as readonly string[]).includes(role.name));

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const localized = (value: unknown): value is { ar: string; en: string } => plain(value) && Object.keys(value).sort().join() === "ar,en" && [value.ar, value.en].every(text => typeof text === "string" && text.trim().length > 0 && Array.from(text).length <= 4000);
const email = (value: unknown): value is string => typeof value === "string" && value.length <= organizationLimits.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const fieldKeys = ["legal_name", "display_name", "country", "billing_email", "seats", "status"];

function fields(b: Record<string, unknown>): OrganizationInput | null {
  if (typeof b.legal_name !== "string" || !b.legal_name.trim() || Array.from(b.legal_name).length > organizationLimits.legalName) return null;
  if (!localized(b.display_name) || typeof b.country !== "string" || !/^[A-Z]{2}$/.test(b.country) || !email(b.billing_email)) return null;
  if ((!Number.isSafeInteger(b.seats) || Number(b.seats) < organizationLimits.seatsMin || Number(b.seats) > organizationLimits.seatsMax)) return null;
  if (b.status !== undefined && !(organizationStatuses as readonly unknown[]).includes(b.status)) return null;
  const name = b.display_name as { ar: string; en: string };
  return {
    legal_name: b.legal_name, display_name: { ar: name.ar, en: name.en }, country: b.country, billing_email: b.billing_email,
    seats: b.seats as number, ...(b.status !== undefined ? { status: b.status as OrganizationInput["status"] } : {}),
  };
}
/** ملف المؤسسة للتعديل بقواعد العقد، أو null. الحالة والمقاعد يحكم فيهما الخادم لمدير النظام وحده. */
export function organizationInput(body: Record<string, unknown>): OrganizationInput | null {
  return Object.keys(body).some(key => !fieldKeys.includes(key)) ? null : fields(body);
}
export function organizationCreate(body: Record<string, unknown>): OrganizationCreate | null {
  if (Object.keys(body).some(key => ![...fieldKeys, "first_admin_email"].includes(key)) || !email(body.first_admin_email)) return null;
  const base = fields(body);
  return base && { ...base, first_admin_email: body.first_admin_email as string };
}
export function memberInvite(body: Record<string, unknown>): MemberInvite | null {
  if (!plain(body) || Object.keys(body).sort().join() !== "email,role" || !email(body.email) || !(buyerRoles as readonly unknown[]).includes(body.role)) return null;
  return { email: body.email, role: body.role as MemberInvite["role"] };
}
export function memberUpdate(body: Record<string, unknown>): MemberUpdate | null {
  if (!plain(body) || Object.keys(body).sort().join() !== "role,status" || !(buyerRoles as readonly unknown[]).includes(body.role) || !(memberStatuses as readonly unknown[]).includes(body.status)) return null;
  return { role: body.role as MemberUpdate["role"], status: body.status as MemberUpdate["status"] };
}
/** المؤسسة للمتصفح بقائمة بيضاء. */
export function safeOrganization(o: Organization): Organization {
  return { id: o.id, legal_name: o.legal_name, display_name: { ar: o.display_name.ar, en: o.display_name.en }, country: o.country, billing_email: o.billing_email, seats: o.seats, status: o.status, active_members: o.active_members, verified_at: o.verified_at ?? null, created_at: o.created_at, updated_at: o.updated_at };
}
export function safeMember(m: Member): Member {
  return { user_id: m.user_id, email: m.email, role: m.role, status: m.status, totp_enabled: m.totp_enabled, created_at: m.created_at };
}
export const inputOf = (o: Organization): OrganizationInput => ({ legal_name: o.legal_name, display_name: o.display_name, country: o.country, billing_email: o.billing_email, seats: o.seats, status: o.status });
export const emptyOrganization = (): OrganizationCreate => ({ legal_name: "", display_name: { ar: "", en: "" }, country: "", billing_email: "", seats: 5, first_admin_email: "" });
