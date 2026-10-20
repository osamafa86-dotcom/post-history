import { randomBytes } from "node:crypto";
import type { SessionStore, StoredSession } from "../src/server/sessions";
import type { Session } from "../src/lib/types";

// بديل للاختبار فقط؛ لا يُستورد في مسار التطبيق أو القياس الحي.
export class MemoryStore implements SessionStore {
  data = new Map<string, StoredSession>();
  private locks = new Map<string, Promise<unknown>>();
  async create(tokens: Session) { const id = randomBytes(32).toString("hex"); await this.save(id, { tokens, deadline: Date.now() + 3600000 }); return id; }
  async read(id: string) { return structuredClone(this.data.get(id) ?? null); }
  async save(id: string, value: StoredSession) { this.data.set(id, structuredClone(value)); }
  async remove(id: string) { this.data.delete(id); }
  async locked<T>(id: string, run: () => Promise<T>) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run); this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
}
