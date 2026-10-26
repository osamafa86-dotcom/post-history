import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import { DB, type Database } from '../database/database.module';
import { buyerInviteConflicts } from '../database/schema/schema';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { iso } from '../materials/material-store';
import { validTimestamp } from '../uploads/uploads.service';
import { type ConflictRow, InviteConflictError, resolveInviteConflict } from './invite-conflicts';

type Conflict = components['schemas']['BuyerInviteConflict'];
type State = components['schemas']['BuyerInviteConflictState'];
type Resolve = components['schemas']['BuyerInviteConflictResolve'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** طابور تعارض الدعوات لمدير النظام (العقد #361): القائمة الأقدم أولًا، والحسم بالحالة وبرمز TOTP. */
@Injectable()
export class InviteConflictsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(q: { state?: State; cursor?: string; limit?: number }): Promise<components['schemas']['BuyerInviteConflictPage']> {
    const limit = q.limit ?? 50;
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db
      .select({ row: buyerInviteConflicts, at: sql<string>`${buyerInviteConflicts.createdAt}::text` })
      .from(buyerInviteConflicts)
      .where(
        and(
          q.state ? eq(buyerInviteConflicts.state, q.state) : undefined,
          after ? sql`(${buyerInviteConflicts.createdAt}, ${buyerInviteConflicts.id}) > (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(asc(buyerInviteConflicts.createdAt), asc(buyerInviteConflicts.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDto(r.row)),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.row.id])).toString('base64url') : null,
    };
  }

  async resolve(adminId: string, conflictId: string, input: Resolve): Promise<Conflict> {
    if (!UUID.test(conflictId)) throw ApiError.notFound();
    try {
      return toDto(await resolveInviteConflict(this.db, { keyring: fieldKeyring(this.config) }, { conflictId, adminId, totp: input.totp_code, to: input.state }));
    } catch (err) {
      if (!(err instanceof InviteConflictError)) throw err;
      if (err.code === 'totp_failed') throw new ApiError(401, 'totp_required', 'A valid TOTP code is required.');
      if (err.code === 'not_found') throw ApiError.notFound();
      if (err.code === 'already_resolved') throw new ApiError(409, 'invalid_transition', 'The conflict cannot move to this state.');
      throw new ApiError(403, 'forbidden_role', 'Only an active system administrator resolves invite conflicts.');
    }
  }
}

function toDto(c: ConflictRow): Conflict {
  return {
    id: c.id,
    organization_id: c.organizationId,
    email: c.email,
    existing_user_id: c.existingUserId,
    role: c.role as Conflict['role'],
    state: c.state as State,
    invited_by: c.invitedBy,
    invite_expires_at: iso(c.inviteExpiresAt)!,
    created_at: iso(c.createdAt)!,
    resolved_at: iso(c.resolvedAt),
    resolved_by: c.resolvedBy,
  };
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && validTimestamp(at) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}

@Controller('buyer-invite-conflicts')
export class InviteConflictsController {
  constructor(private readonly conflicts: InviteConflictsService) {}

  @Get()
  @Roles('system_admin')
  list(@Query() query: Record<string, unknown>): Promise<components['schemas']['BuyerInviteConflictPage']> {
    return this.conflicts.list(validateQuery('/buyer-invite-conflicts', 'get', query));
  }

  @Post(':conflictId/resolve')
  @Roles('system_admin')
  @HttpCode(200)
  resolve(@Param('conflictId') id: string, @Body() body: unknown, @Req() req: Request): Promise<Conflict> {
    return this.conflicts.resolve(req.principal!.userId, id, validateBody<Resolve>('/buyer-invite-conflicts/{conflict_id}/resolve', 'post', body));
  }
}
