import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS } from '../common/redis.module';
import { AttestationUnavailable } from './play-integrity';

const TTL_SECONDS = 300;
const PREFIX = 'ingest:challenge:';

export interface IssuedChallenge {
  id: string;
  challenge: Buffer;
  expiresAt: Date;
}

/**
 * تحديات شهادة الجهاز (ADR 0011): 32 بايتًا عشوائية، مربوطة بالمستخدم، عمرها 300 ث، تُستهلك مرة واحدة (GETDEL) فلا
 * يُعاد استعمال تحدٍّ في تسجيلين أو رمزين. Redis مشترك بين النسخ؛ بلا Redis (خارج الإنتاج) ذاكرة العملية.
 * تعطل Redis = 503 attestation_unavailable لا قبول بلا تحقق.
 */
@Injectable()
export class ChallengeStore {
  private readonly memory = new Map<string, { userId: string; challenge: Buffer; expiresAt: number }>();

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async issue(userId: string): Promise<IssuedChallenge> {
    const id = randomUUID();
    const challenge = randomBytes(32);
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    if (this.redis) {
      try {
        await this.redis.set(PREFIX + id, JSON.stringify({ u: userId, c: challenge.toString('base64url') }), 'EX', TTL_SECONDS);
      } catch {
        throw new AttestationUnavailable(5);
      }
    } else {
      this.sweep();
      this.memory.set(id, { userId, challenge, expiresAt: expiresAt.getTime() });
    }
    return { id, challenge, expiresAt };
  }

  /** التحدي الخام إن كان حيًّا ولهذا المستخدم، ويُحذف في الحالين؛ وإلا null (410 challenge_expired). */
  async consume(id: string, userId: string): Promise<Buffer | null> {
    if (this.redis) {
      let raw: string | null;
      try {
        raw = await this.redis.getdel(PREFIX + id);
      } catch {
        throw new AttestationUnavailable(5);
      }
      if (!raw) return null;
      const stored = JSON.parse(raw) as { u: string; c: string };
      return stored.u === userId ? Buffer.from(stored.c, 'base64url') : null;
    }
    const stored = this.memory.get(id);
    this.memory.delete(id);
    if (!stored || stored.expiresAt <= Date.now() || stored.userId !== userId) return null;
    return stored.challenge;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, c] of this.memory) if (c.expiresAt <= now) this.memory.delete(id);
  }
}
