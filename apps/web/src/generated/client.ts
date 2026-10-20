// ملف مولّد بواسطة scripts/generate-client.sh؛ لا يُعدّل يدويًا.
import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";
export function createApiClient(options: ClientOptions) {
  return createClient<paths>(options);
}
