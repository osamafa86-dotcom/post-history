// Direct database access for the live scripts: the API has no endpoint yet that creates an upload session,
// so sessions are inserted the way the integration tests do, and everything after that goes through the real API.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

export const sha256 = (s) => createHash("sha256").update(s).digest();

export function openDb(url) {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    pool,
    async uploadSession({ materialId, createdBy, size, clientSha256 = null, kind = "original" }) {
      const token = randomBytes(16).toString("base64url");
      const { rows } = await pool.query(
        `INSERT INTO upload_sessions (material_id, created_by, kind, state, size_bytes, filename, part_size_bytes, upload_token_hash, client_sha256, expires_at)
         VALUES ($1, $2, $3, 'created', $4, 'clip.mp4', 16777216, $5, $6, now() + interval '1 hour') RETURNING id`,
        [materialId, createdBy, kind, size, sha256(token), clientSha256 ? Buffer.from(clientSha256, "hex") : null],
      );
      return { id: rows[0].id, token, size };
    },
    close: () => pool.end(),
  };
}
