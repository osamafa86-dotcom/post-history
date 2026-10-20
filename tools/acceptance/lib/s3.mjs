// Minimal S3 access for the acceptance tools (MinIO locally and in CI, R2 in production): bucket setup, put, head, hashed read.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export function s3FromEnv(env = process.env, prefix = "S3") {
  const endpoint = env[`${prefix}_ENDPOINT`], accessKeyId = env[`${prefix}_ACCESS_KEY`], secretAccessKey = env[`${prefix}_SECRET_KEY`];
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const client = new S3Client({ endpoint, region: env[`${prefix}_REGION`] ?? "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  return {
    client,
    async ensureBucket(bucket) {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket })); } catch { await client.send(new CreateBucketCommand({ Bucket: bucket })); }
    },
    put: (bucket, key, body) => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })),
    async head(bucket, key) {
      try { return Number((await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength); } catch (e) {
        if (e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    /** Size, ETag and last-modified of an object (the "original not touched" evidence), or null. */
    async stat(bucket, key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength), etag: r.ETag, lastModified: r.LastModified?.toISOString() };
      } catch (e) {
        if (e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    /** Keys and sizes under a prefix (every page). */
    async list(bucket, prefix) {
      const out = [];
      let token;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) out.push({ key: o.Key, size: Number(o.Size) });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    /** Downloads an object to a local file. */
    async download(bucket, key, path) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(res.Body, createWriteStream(path));
    },
    /** Streams the stored object through SHA-256, the server-side truth a tus client cannot read back once downloads are disabled. */
    async sha256(bucket, key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const h = createHash("sha256");
        for await (const chunk of res.Body) h.update(chunk);
        return h.digest("hex");
      } catch (e) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === "NoSuchKey") return null;
        throw e;
      }
    },
  };
}

/** tusd names the S3 object `<prefix><id>`; for multipart uploads the URL id is `<id>+<multipartId>`. */
export const tusObjectKey = (prefix, location) => prefix + new URL(location).pathname.replace(/\/$/, "").split("/").pop().split("+")[0];
