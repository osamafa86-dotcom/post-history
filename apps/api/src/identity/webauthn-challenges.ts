import { and, eq, isNull, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../common/crypto';
import type { Executor } from '../database/database.module';
import { webauthnChallenges } from '../database/schema/schema';

export type ChallengePurpose = 'registration' | 'authentication';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * تحديات WebAuthn (ADR 0107) في Postgres: تُحفظ ببصمة SHA-256 لنص التحدي (`options.challenge` بترميز base64url) وحدها، ولمرة
 * واحدة (الاستهلاك حذف)، وعمرها من البيئة. تحدي التسجيل لمستخدمه، وتحدي الدخول بلا مستخدم. نص التحدي لا يُسجَّل ولا يُخزَّن.
 */
export class WebAuthnChallenges {
  constructor(private readonly ttlSeconds: number) {}

  /** يحفظ بصمة تحدٍّ صادر ويعيد معرّفه وانتهاءه؛ ويكنس المنتهي في الطريق (فهرس expires_at). */
  async save(db: Executor, purpose: ChallengePurpose, userId: string | null, challenge: string): Promise<{ id: string; expiresAt: string }> {
    await db.execute(sql`DELETE FROM ${webauthnChallenges} WHERE id IN (
      SELECT id FROM ${webauthnChallenges} WHERE expires_at < now() ORDER BY expires_at LIMIT 200)`);
    const [row] = await db
      .insert(webauthnChallenges)
      .values({
        purpose,
        userId,
        challengeHash: sha256(challenge),
        expiresAt: sql`now() + make_interval(secs => ${this.ttlSeconds})` as never,
      })
      .returning({ id: webauthnChallenges.id, expiresAt: webauthnChallenges.expiresAt });
    return { id: row!.id, expiresAt: new Date(row!.expiresAt).toISOString() };
  }

  /**
   * يستهلك التحدي (يحذفه) ويعيد بصمته إن كان حيًّا ولهذا الغرض ولهذا المستخدم؛ وإلا null (410 challenge_expired). يُستهلك في
   * الحالين، فالرد الذي لا يتحقق لا يُعاد بالتحدي نفسه.
   */
  async consume(db: Executor, id: string, purpose: ChallengePurpose, userId: string | null): Promise<Buffer | null> {
    if (!UUID.test(id)) return null;
    const owner = userId === null ? isNull(webauthnChallenges.userId) : eq(webauthnChallenges.userId, userId);
    const [row] = await db
      .delete(webauthnChallenges)
      .where(and(eq(webauthnChallenges.id, id.toLowerCase()), eq(webauthnChallenges.purpose, purpose), owner))
      .returning({ hash: webauthnChallenges.challengeHash, live: sql<boolean>`${webauthnChallenges.expiresAt} > now()` });
    return row?.live ? row.hash : null;
  }
}

/** مطابِق التحدي للمكتبة: بصمة ما وقّعه المصادِق مقابل البصمة المحفوظة، بمقارنة ثابتة الزمن. */
export function matchesChallenge(hash: Buffer): (challenge: string) => boolean {
  return (challenge) => typeof challenge === 'string' && challenge.length <= 512 && timingSafeEqual(sha256(challenge), hash);
}
