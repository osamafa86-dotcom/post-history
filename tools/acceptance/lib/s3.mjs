// Minimal S3 access for the acceptance tools (MinIO locally and in CI, R2 in production): bucket setup, put, head, hashed read.
import { createHash } from "node:crypto";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
