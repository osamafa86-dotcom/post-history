import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { uploadSessions } from '../database/schema/schema';
import type { components } from '../generated/api';
import { abortRevokedUpload, markReceived, markUploadFailed, uploadAccessRevoked } from './upload-completion';

export type TusdHookRequest = components['schemas']['TusdHookRequest'];
export type TusdHookResponse = components['schemas']['TusdHookResponse'];

const REJECT: TusdHookResponse = {
  RejectUpload: true,
  HTTPResponse: { StatusCode: 403, Body: 'upload rejected' },
};

const ACCEPT: TusdHookResponse = { RejectUpload: false };

/** خطّافات tusd (ADR SEC-06). الخادم لا يثق بشيء من الخطّاف إلا ما يطابق جلسة الرفع المحفوظة. */
@Injectable()
export class TusdHooksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** مفتاح الكائن الذي تتوقعه الجلسة؛ يُثبَّت في pre-create عبر ChangeFileInfo.ID ويُطابَق في post-finish. */
  expectedStorageKey(sessionId: string): string {
    return `${this.config.TUSD_OBJECT_PREFIX}${sessionId}`;
  }

  async handle(hook: TusdHookRequest): Promise<TusdHookResponse> {
    switch (hook.Type) {
      case 'pre-create':
        return this.preCreate(hook);
      case 'post-create':
        return this.config.TUSD_POST_CREATE_HOOK ? this.postCreate(hook) : ACCEPT;
      case 'post-finish':
        return this.postFinish(hook);
      default:
        return ACCEPT;
    }
  }

  private async preCreate(hook: TusdHookRequest): Promise<TusdHookResponse> {
    const sessionId = hook.Event.Upload.MetaData.upload_session_id;
    const token = bearerToken(hook.Event.HTTPRequest.Header);
    if (!token) return REJECT;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId))
        .for('update');
      if (
        !session ||
        !session.uploadTokenHash ||
        !timingSafeEqual(session.uploadTokenHash, sha256(token)) ||
        // الرمز يفتح إنشاء رفع واحد: بعد إنشائه تصبح الجلسة in_progress فلا يُقبل ثانية (الاستئناف عبر PATCH لا يمر
        // بهذا الخطّاف). إلى أن يفصل العقد عمر الرمز عن عمر الجلسة، هذا ما يحد من رمز مسرّب.
        session.state !== 'created' ||
        // انتهاء الرمز (عمود مستقل في v0.1، لا يتجاوز انتهاء الجلسة)
        !session.uploadTokenExpiresAt ||
        new Date(session.uploadTokenExpiresAt) <= new Date() ||
        new Date(session.expiresAt) <= new Date() ||
        Number(session.sizeBytes) !== hook.Event.Upload.Size
      ) {
        return REJECT;
      }
      const storageKey = this.expectedStorageKey(session.id);
      if (!this.config.TUSD_POST_CREATE_HOOK) {
        await tx.update(uploadSessions).set({ state: 'in_progress', storageKey }).where(eq(uploadSessions.id, session.id));
        return { RejectUpload: false, ChangeFileInfo: { ID: session.id } };
      }
      // مع post-create تبقى الجلسة created فيُعاد إنشاء فشل لدى tusd بالرمز نفسه. لكن tusd لا يرفض المعرّف المكرّر:
      // إنشاءان بمعرّف الجلسة يتشاركان الكائن. فتُحجز الجلسة هنا ذريًا (الصف مقفل) ويُرفض أي pre-create آخر ما دام
      // الحجز حيًّا؛ post-create يُفرج عنه، وانقضاء المهلة يسمح بإعادة إنشاء فشل.
      const [reserved] = await tx
        .update(uploadSessions)
        .set({
          storageKey,
          hookReservedUntil: sql`now() + make_interval(secs => ${this.config.TUSD_PRE_CREATE_RESERVATION_SECONDS})`,
        })
        .where(
          sql`${uploadSessions.id} = ${session.id} AND (${uploadSessions.hookReservedUntil} IS NULL OR ${uploadSessions.hookReservedUntil} <= now())`,
        )
        .returning({ id: uploadSessions.id });
      return reserved ? { RejectUpload: false, ChangeFileInfo: { ID: session.id } } : REJECT;
    });
  }

  /** نجح إنشاء الرفع لدى tusd: created → in_progress ويُفرج عن الحجز، فلا يُقبل الرمز بعدها. التكرار وما بعد created بلا أثر. */
  private async postCreate(hook: TusdHookRequest): Promise<TusdHookResponse> {
    const sessionId = hook.Event.Upload.MetaData.upload_session_id;
    await this.db
      .update(uploadSessions)
      .set({ state: 'in_progress', hookReservedUntil: null })
      .where(sql`${uploadSessions.id} = ${sessionId} AND ${uploadSessions.state} = 'created'`);
    return ACCEPT;
  }

  private async postFinish(hook: TusdHookRequest): Promise<TusdHookResponse> {
    const sessionId = hook.Event.Upload.MetaData.upload_session_id;
    const storage = hook.Event.Upload.Storage;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId))
        .for('update');
      if (!session) throw ApiError.notFound();
      // tusd يعيد المحاولة: ما سُجّل اكتماله أو فشله سابقًا يعيد 200 نفسها دون أثر جديد
      if (!['created', 'in_progress'].includes(session.state)) return ACCEPT;

      // رفع جارٍ لصاحب أُبطل وصوله أثناءه لا يكتمل (لا إيصال ولا حدث وسائط)
      if (await uploadAccessRevoked(tx, session)) {
        await abortRevokedUpload(tx, session);
        return ACCEPT;
      }
      const expectedKey = session.storageKey ?? this.expectedStorageKey(session.id);
      const keyMatches = storage?.Key === expectedKey;
      const bucketMatches = storage?.Bucket === undefined || storage.Bucket === this.config.S3_BUCKET_UPLOADS;
      if (!keyMatches || !bucketMatches) await markUploadFailed(tx, session, 'storage_error');
      // الحجم الفعلي وSHA-256 يحسبهما المُتحقق من التخزين بعد التجميع (لا يُحفظ شيء من الخطّاف). هنا: الاكتمال فقط.
      else await markReceived(tx, session, expectedKey, hook.Event.Upload.ID ?? undefined);
      return ACCEPT;
    });
  }
}

function bearerToken(headers: Record<string, string[]> | undefined): string | undefined {
  if (!headers) return undefined;
  const name = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const value = name ? headers[name]?.[0] : undefined;
  const match = value ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1];
}
