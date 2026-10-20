import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { randomToken, sha256 } from '../common/crypto';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { pushDevices, recoveryRequests, refreshTokens, uploadSessions, users } from '../database/schema/schema';
import { abortRevokedUpload } from '../uploads/upload-completion';
import type { AuthContext } from './auth.guard';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
}

interface AccessClaims {
  sub: string;
  sid: string;
}

const JWT_ISSUER = 'post-history-api';
// أقصى طول لسلسلة التدوير يُتبع عند التحقق؛ أطول منها يُعد مبطَلًا
const MAX_CHAIN = 1000;

/**
 * نموذج الجلسة (SEC-02): رمز وصول JWT قصير يحمل معرّف صف رمز التحديث (sid)، ورمز تحديث عشوائي
 * يُخزَّن مُجزَّأً ويُدوَّر عند كل تحديث (الصف القديم يُبطَل ويشير إلى بديله في replaced_by).
 * الجلسة = سلسلة التدوير؛ رأسها هو الصف الوحيد غير المبطَل. رمز الوصول صالح ما دام رأس سلسلته صالحًا،
 * فالإبطال (خروج، فقد هاتف) يسري على الطلب التالي دون انتظار انتهاء الرمز.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  async issue(tx: Executor, userId: string, previous?: { installationId: string | null; platform: string | null }): Promise<IssuedTokens & { sessionId: string }> {
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const [row] = await tx
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: sha256(refreshToken),
        installationId: previous?.installationId ?? null,
        platform: previous?.platform ?? null,
        expiresAt: expiresAt.toISOString(),
      })
      .returning({ id: refreshTokens.id });
    const sessionId = row!.id;
    const accessExpiresAt = new Date(Date.now() + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: sessionId } satisfies AccessClaims, {
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
    return { accessToken, refreshToken, accessExpiresAt, sessionId };
  }

  /** يتحقق من رمز الوصول ومن أن رأس سلسلة جلسته ما زال صالحًا والمستخدم نشط. */
  async authenticate(accessToken: string): Promise<AuthContext | null> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(accessToken);
    } catch {
      return null;
    }
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
    const head = await this.chainHead(this.db, claims.sid);
    if (!head || head.user_id !== claims.sub || head.revoked_at !== null || new Date(head.expires_at) <= new Date()) {
      return null;
    }
    const [user] = await this.db
      .select({ status: users.status, credentialResetRequired: users.credentialResetRequired, resetWindowOpen: resetWindowOpen() })
      .from(users)
      .where(eq(users.id, claims.sub));
    if (user?.status !== 'active') return null;
    // الجلسة المقيّدة تنتهي بانتهاء مهلة رمز إعادة التعيين، ولو بقي في رمز الوصول عمر
    if (user.credentialResetRequired && !user.resetWindowOpen) return null;
    return { userId: claims.sub, sessionId: claims.sid, credentialResetRequired: user.credentialResetRequired };
  }

  /** يدوّر رمز التحديث. إعادة استخدام رمز دُوِّر سابقًا تُعد سرقة فتُبطل الجلسة كلها. */
  async refresh(refreshToken: string): Promise<(IssuedTokens & { userId: string }) | null> {
    return this.db.transaction(async (tx) => {
      const hash = sha256(refreshToken);
      const [current] = await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, sql`now()`)))
        .returning();
      if (!current) {
        const [reused] = await tx
          .select({ id: refreshTokens.id, replacedBy: refreshTokens.replacedBy })
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hash));
        if (reused?.replacedBy) await this.revokeChain(tx, reused.id);
        return null;
      }
      const [user] = await tx
        .select({ status: users.status, credentialResetRequired: users.credentialResetRequired, resetWindowOpen: resetWindowOpen() })
        .from(users)
        .where(eq(users.id, current.userId));
      if (user?.status !== 'active') return null;
      // تحديث الجلسة المقيّدة مسموح حتى reset_token_expires_at للطلب المكتمل، ثم 401 واستعادة جديدة من أولها
      if (user.credentialResetRequired && !user.resetWindowOpen) return null;
      const issued = await this.issue(tx, current.userId, {
        installationId: current.installationId,
        platform: current.platform,
      });
      await tx.update(refreshTokens).set({ replacedBy: issued.sessionId }).where(eq(refreshTokens.id, current.id));
      return { ...issued, userId: current.userId };
    });
  }

  /** جلسات المستخدم النشطة (رؤوس السلاسل غير المبطَلة وغير المنتهية). */
  async listActive(userId: string): Promise<Array<typeof refreshTokens.$inferSelect>> {
    return this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, sql`now()`)))
      .orderBy(refreshTokens.createdAt);
  }

  /** يبطل الجلسة التي ينتمي إليها sid (رأس سلسلتها). */
  async revokeChain(tx: Executor, sid: string): Promise<void> {
    const head = await this.chainHead(tx, sid);
    if (head && head.revoked_at === null) {
      await tx.update(refreshTokens).set({ revokedAt: sql`now()` }).where(eq(refreshTokens.id, head.id));
    }
  }

  /** يبطل كل جلسات المستخدم ورموز رفعه المفتوحة وأجهزة إشعاره (فقد الهاتف). */
  async revokeAll(tx: Tx, userId: string): Promise<void> {
    await revokeAllAccess(tx, userId);
  }

  async chainHead(
    executor: Executor,
    sid: string,
  ): Promise<{ id: string; user_id: string; revoked_at: string | null; expires_at: string } | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return undefined;
    const result = await executor.execute<{ id: string; user_id: string; revoked_at: string | null; expires_at: string }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, user_id, revoked_at, expires_at, replaced_by, 1 AS depth
          FROM refresh_tokens WHERE id = ${sid}::uuid
        UNION ALL
        SELECT r.id, r.user_id, r.revoked_at, r.expires_at, r.replaced_by, c.depth + 1
          FROM refresh_tokens r JOIN chain c ON r.id = c.replaced_by
         WHERE c.depth < ${MAX_CHAIN}
      )
      SELECT id, user_id, revoked_at, expires_at FROM chain WHERE replaced_by IS NULL`);
    return result.rows[0];
  }
}

/**
 * مهلة الجلسة المقيّدة لصاحب الصف في users: طلب استعادة أُكمل بـ /auth/recovery/complete ولم تنقضِ مهلة رمزه.
 * قبل الإكمال لا جلسة أصلًا (الاعتماد أبطل كل شيء والدخول مرفوض)، فلا يُفتح بها غير المسار المقيّد.
 */
function resetWindowOpen() {
  // users.id مكتوب صراحة: داخل الاختيار يرسم Drizzle العمود بلا اسم جدوله فيُقرأ "id" عمودًا من rr
  return sql<boolean>`EXISTS (SELECT 1 FROM ${recoveryRequests} rr
    WHERE rr.user_id = users.id AND rr.completed_at IS NOT NULL AND rr.reset_token_expires_at > now())`;
}

export const JWT_OPTIONS = { issuer: JWT_ISSUER, algorithm: 'HS256' as const };

/**
 * إبطال كل وصول الحساب: سلاسل التحديث، وأجهزة الإشعار، وجلسات الرفع الحية. يستعمله أمر CLI أيضًا (بلا Nest).
 * جلسة الرفع الحية (لم تُنشأ بعد، أو جارية، أو اكتملت بانتظار التحقق) يُصفَّر رمزها وتفشل `aborted` في المعاملة نفسها،
 * فلا يصدر لها إيصال ولا حدث وسائط بعد الإبطال؛ وكل نقطة اكتمال تعيد الفحص (uploadAccessRevoked) لما يسبق قفل الصف.
 */
export async function revokeAllAccess(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  const live = await tx
    .update(uploadSessions)
    .set({ uploadTokenHash: null, uploadTokenExpiresAt: null })
    .where(and(eq(uploadSessions.createdBy, userId), sql`${uploadSessions.state} IN ('created', 'in_progress', 'completed')`))
    .returning();
  for (const session of live) await abortRevokedUpload(tx, session);
  await tx
    .update(pushDevices)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(pushDevices.userId, userId), isNull(pushDevices.revokedAt)));
}
