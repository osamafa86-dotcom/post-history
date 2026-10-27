import type { Me } from "./types";
import { hasRole } from "./review";

/** اسم داخلي من العقد وحده؛ لا يُستنتج من بريد أو اسم حقيقي. */
export const workName = (value: unknown): string | null => typeof value === "string" && value.trim() === value && Array.from(value).length >= 1 && Array.from(value).length <= 80 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value : null;
export const internalNames = (me: Me) => !hasRole(me, "reporter", "buyer_admin", "buyer_member") && hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin", "finance");
