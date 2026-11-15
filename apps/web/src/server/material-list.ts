import { states } from "@/lib/query";
import type { Material, MaterialPage, MaterialQuery } from "@/lib/types";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

type State = Material["editorial_state"];
const mark = "m.";

/** حالات الاستعلام حين تكون قائمة (`a,b,c`، تحقّق منها `materialQuery`)، وإلا `null`: الحالة الواحدة تمرّ إلى الخادم كما هي. */
export function stateList(query: MaterialQuery): State[] | null {
  const value: string | undefined = query.editorial_state;
  return value?.includes(",") ? value.split(",") as State[] : null;
}

/** موضع كل حالة في المؤشّر المركّب: `null` = من أولها، وغياب الحالة = انتهت صفحاتها. مؤشّر ليس من صنع هذه القائمة يُرفض. */
function positions(cursor: string | undefined, list: State[]): Partial<Record<State, string | null>> {
  if (cursor === undefined) return Object.fromEntries(list.map(state => [state, null]));
  let value: unknown;
  try { if (!cursor.startsWith(mark)) throw new Error("foreign"); value = JSON.parse(Buffer.from(cursor.slice(mark.length), "base64url").toString("utf8")); } catch { throw new WebError(400, "request_failed"); }
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  if (!entries.length || entries.some(([state, at]) => !(list as string[]).includes(state) || !(states.editorial_state as readonly string[]).includes(state) || typeof at !== "string" || !at || at.length > 2048)) throw new WebError(400, "request_failed");
  return Object.fromEntries(entries);
}

/** ترتيب الخادم نفسه لكل قيمة `sort` (ثم المعرّف)؛ و`shot_desc` يضع غير المؤرَّخ أولًا كما يفعل الخادم. */
function order(sort: MaterialQuery["sort"]) {
  const direction = sort === "created_asc" ? 1 : -1;
  const at = (m: Material) => { const value = sort === "shot_desc" ? m.shot_at : sort === "updated_desc" ? m.updated_at : m.created_at; return value ? Date.parse(value) : Infinity; };
  return (a: Material, b: Material) => direction * (at(a) - at(b)) || direction * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * قائمة المواد للـBFF. عقد `/materials` يقبل حالة تحريرية واحدة، وتبويب «قيد المراجعة» في الوارد ثلاث حالات: يُسأل الخادم مرة لكل حالة بالاستعلام
 * نفسه، وتُدمج الصفحات بترتيب الاستعلام. لكل حالة مؤشّرها كما أعاده الخادم، والمؤشّر المركّب يحملها معًا، فلا تتكرر مادة ولا تسقط بين الصفحات؛
 * والحالة التي انتهت صفحاتها لا تُسأل ثانية. الصفحة تحمل حتى `limit` من كل حالة، والترتيب داخل الصفحة لا بين الصفحات.
 */
export async function listMaterials(api: Api, query: MaterialQuery): Promise<MaterialPage> {
  const list = stateList(query);
  if (!list) return requireOk(await api.GET("/materials", { params: { query } }));
  const at = positions(query.cursor, list), asked = list.filter(state => state in at);
  const pages = await Promise.all(asked.map(async state => requireOk(await api.GET("/materials", { params: { query: { ...query, editorial_state: state, cursor: at[state] ?? undefined } } }))));
  const next = Object.fromEntries(asked.flatMap((state, index) => pages[index].next_cursor ? [[state, pages[index].next_cursor]] : []));
  return { items: pages.flatMap(page => page.items).sort(order(query.sort)), next_cursor: Object.keys(next).length ? mark + Buffer.from(JSON.stringify(next)).toString("base64url") : null };
}
