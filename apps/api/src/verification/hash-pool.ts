import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

/**
 * يحسب SHA-256 خارج خيط الحدث. الحساب على خيط الحدث يتسلسل (نحو 355 MiB/s لكل الملفات معًا)، فالتحقق المتوازي
 * لم يكن يتوازى فعلًا. كل خيط يحسب بصمة ملف واحد في وقته؛ الخيط الرئيسي يقرأ التدفق ويرسل دفعات (BATCH_BYTES)
 * بحد أقصى IN_FLIGHT دفعة غير مُقرّ بها لكل ملف، فالذاكرة محدودة مهما كان حجم الملف.
 * الشيفرة مضمّنة نصًا (eval) فتعمل كما هي في البناء وفي ts-jest دون ملف منفصل.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
let hash = null;
parentPort.on('message', (m) => {
  if (m.t === 'start') hash = createHash('sha256');
  else if (m.t === 'data') { hash.update(new Uint8Array(m.b)); parentPort.postMessage({ t: 'ack' }); }
  else if (m.t === 'end') { const d = hash.digest(); hash = null; parentPort.postMessage({ t: 'digest', d }); }
});
`;

const BATCH_BYTES = 4 * 1024 * 1024;
const IN_FLIGHT = 2;

export interface HashResult {
  sha256: Buffer;
  bytes: number;
}

/** الحساب في الخيط نفسه: لعامل الوسائط والاختبارات، وهو ما يحل محله المجمّع. */
export async function hashInline(stream: AsyncIterable<unknown>): Promise<HashResult> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest(), bytes };
}

export class HashPool {
  private readonly idle: Worker[] = [];
  private readonly waiting: Array<(w: Worker) => void> = [];
  private size = 0;
  private closed = false;

  constructor(private readonly threads: number) {
    if (!Number.isInteger(threads) || threads < 1) throw new Error('HashPool needs at least one thread');
  }

  async hash(stream: AsyncIterable<unknown>): Promise<HashResult> {
    const worker = await this.acquire();
    let healthy = true;
    try {
      return await this.run(worker, stream);
    } catch (err) {
      // خيط في حالة غير معروفة (خطأ في التدفق أثناء الإرسال أو عطل في الخيط) لا يُعاد إلى المجمّع
      healthy = false;
      throw err;
    } finally {
      this.release(worker, healthy);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = this.idle.splice(0);
    await Promise.all(all.map((w) => w.terminate()));
  }

  private run(worker: Worker, stream: AsyncIterable<unknown>): Promise<HashResult> {
    return new Promise<HashResult>((resolve, reject) => {
      let pendingAcks = 0;
      let wake: (() => void) | undefined;
      let failed: Error | undefined;
      const fail = (err: Error) => {
        failed ??= err;
        wake?.();
        reject(err);
      };
      const onMessage = (m: { t: string; d?: Uint8Array }) => {
        if (m.t === 'ack') {
          pendingAcks--;
          wake?.();
        } else if (m.t === 'digest') {
          cleanup();
          resolve({ sha256: Buffer.from(m.d!), bytes });
        }
      };
      const onError = (err: Error) => {
        cleanup();
        fail(err);
      };
      const onExit = (code: number) => onError(new Error(`hash worker exited with code ${code}`));
      const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);

      let bytes = 0;
      const send = async (parts: Buffer[], length: number) => {
        while (pendingAcks >= IN_FLIGHT && !failed) await new Promise<void>((r) => (wake = r));
        if (failed) throw failed;
        // نسخة واحدة في ذاكرة يملكها الطرف المستقبل وحده فتُنقل إلى الخيط بلا نسخ ثانٍ (أجزاء التدفق قد تكون شرائح
        // من ذاكرة مشتركة لا يجوز نقلها)
        const owned = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          owned.set(part, offset);
          offset += part.length;
        }
        pendingAcks++;
        worker.postMessage({ t: 'data', b: owned.buffer }, [owned.buffer]);
      };

      (async () => {
        worker.postMessage({ t: 'start' });
        let parts: Buffer[] = [];
        let partBytes = 0;
        for await (const chunk of stream) {
          const buf = chunk as Buffer;
          bytes += buf.length;
          parts.push(buf);
          partBytes += buf.length;
          if (partBytes >= BATCH_BYTES) {
            await send(parts, partBytes);
            parts = [];
            partBytes = 0;
          }
        }
        if (partBytes > 0) await send(parts, partBytes);
        worker.postMessage({ t: 'end' });
      })().catch((err: unknown) => {
        cleanup();
        fail(err as Error);
      });
    });
  }

  private acquire(): Promise<Worker> {
    if (this.closed) return Promise.reject(new Error('HashPool is closed'));
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    if (this.size < this.threads) {
      this.size++;
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      // الخيط الخامل لا يُبقي العملية حية
      worker.unref();
      return Promise.resolve(worker);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker, healthy: boolean): void {
    if (!healthy || this.closed) {
      this.size--;
      void worker.terminate();
      if (!this.closed && this.waiting.length > 0) void this.acquire().then(this.waiting.shift()!);
      return;
    }
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }
}
