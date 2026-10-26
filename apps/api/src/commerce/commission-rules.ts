import { Body, Controller, Get, Inject, Injectable, Post, Query, Req } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, commissionRules, materials } from '../database/schema/schema';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { iso } from '../materials/material-store';

type CommissionRule = components['schemas']['CommissionRule'];
type CommissionRuleInput = components['schemas']['CommissionRuleInput'];
type Scope = components['schemas']['CommissionScope'];
type RuleRow = typeof commissionRules.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** الأكثر تحديدًا أولًا (ADR 0025 الجزء 6): المادة، ثم المراسل، ثم نوع المادة، ثم الافتراضية. */
const PRECEDENCE: readonly Scope[] = ['material', 'reporter', 'material_type', 'default'];

/** القاعدة المجمّدة في بند البيعة: معرّفها، أو `config` حين لا قاعدة فتُستعمل PLATFORM_COMMISSION_BASIS_POINTS. */
export interface AppliedRule {
  ruleId: string;
  basisPoints: number;
}

/**
 * القاعدة السارية لبند لحظة تأكيد الدفع: من النطاقات بالأسبقية، وفي النطاق الواحد ما طابق نوع الترخيص قبل ما يعمّ الأنواع،
 * ثم أحدث `effective_from` لا يتجاوز `at`. للمادة بأكثر من نوع: أحدث قاعدة نوع بين أنواعها، والتعادل بالمعرّف.
 */
export async function applicableRule(
  executor: Executor,
  item: { materialId: string; licenseType: string },
  at: string,
  fallbackBasisPoints: number,
): Promise<AppliedRule> {
  const [m] = await executor.select({ reporterId: materials.reporterId, types: materials.materialTypes }).from(materials).where(eq(materials.id, item.materialId));
  const ids: Record<Scope, string[]> = { material: [item.materialId], reporter: m ? [m.reporterId] : [], material_type: m?.types ?? [], default: [] };
  const rows = await executor
    .select()
    .from(commissionRules)
    .where(
      and(
        lte(commissionRules.effectiveFrom, at),
        or(isNull(commissionRules.licenseType), eq(commissionRules.licenseType, item.licenseType)),
        or(
          and(eq(commissionRules.scope, 'default'), isNull(commissionRules.scopeId)),
          ...(['material', 'reporter', 'material_type'] as const)
            .filter((s) => ids[s].length > 0)
            .map((s) => and(eq(commissionRules.scope, s), inArray(commissionRules.scopeId, ids[s]))),
        ),
      ),
    );
  for (const scope of PRECEDENCE) {
    const inScope = rows.filter((r) => r.scope === scope);
    if (inScope.length === 0) continue;
    const exact = inScope.filter((r) => r.licenseType === item.licenseType);
    const pick = (exact.length > 0 ? exact : inScope).sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom ? (a.id < b.id ? 1 : -1) : Date.parse(b.effectiveFrom.replace(' ', 'T')) - Date.parse(a.effectiveFrom.replace(' ', 'T')),
    )[0]!;
    return { ruleId: pick.id, basisPoints: pick.platformBasisPoints };
  }
  return { ruleId: 'config', basisPoints: fallbackBasisPoints };
}

@Injectable()
export class CommissionRulesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(q: { scope?: Scope }): Promise<{ items: CommissionRule[] }> {
    const rows = await this.db
      .select()
      .from(commissionRules)
      .where(q.scope ? eq(commissionRules.scope, q.scope) : undefined)
      .orderBy(desc(commissionRules.effectiveFrom), desc(commissionRules.id));
    return { items: rows.map(toDto) };
  }

  /** إصدار جديد لا يعدّل سابقه؛ النطاق ونوع الترخيص وتاريخ السريان نفسها `409 conflict`. */
  async create(actorId: string, input: CommissionRuleInput): Promise<CommissionRule> {
    const scopeId = input.scope_id ?? null;
    const scopeOk =
      input.scope === 'default'
        ? scopeId === null
        : input.scope === 'material_type'
          ? scopeId !== null && !UUID.test(scopeId)
          : scopeId !== null && UUID.test(scopeId);
    if (!scopeOk) throw ApiError.validation({ fields: ['/scope_id'] });
    return this.db.transaction(async (tx) => {
      let row: RuleRow;
      try {
        row = await tx.transaction(async (sp) => {
          const [r] = await sp
            .insert(commissionRules)
            .values({
              scope: input.scope,
              scopeId,
              licenseType: input.license_type ?? null,
              platformBasisPoints: input.platform_basis_points,
              effectiveFrom: input.effective_from,
              createdBy: actorId,
            })
            .returning();
          return r!;
        });
      } catch (err) {
        const e = pgError(err);
        if (e.constraint === 'commission_rules_key') throw new ApiError(409, 'commission_rule_exists', 'A rule with this scope and effective date exists.');
        // نوع مادة خارج القائمة المسموحة يرفضه قيد النطاق
        if (e.constraint === 'commission_rules_scope_id_check') throw ApiError.validation({ fields: ['/scope_id'] });
        throw err;
      }
      await tx.insert(auditLog).values({
        actorId,
        action: 'commission_rule.created',
        targetType: 'commission_rule',
        targetId: row.id,
        details: { rule_id: row.id },
        hash: Buffer.alloc(32),
      });
      return toDto(row);
    });
  }
}

function toDto(r: RuleRow): CommissionRule {
  return {
    id: r.id,
    scope: r.scope as Scope,
    scope_id: r.scopeId,
    license_type: r.licenseType as CommissionRule['license_type'],
    platform_basis_points: r.platformBasisPoints,
    effective_from: iso(r.effectiveFrom)!,
    created_by: r.createdBy,
    created_at: iso(r.createdAt)!,
  };
}

@Controller('commission-rules')
export class CommissionRulesController {
  constructor(private readonly rules: CommissionRulesService) {}

  @Get()
  @Roles('system_admin', 'finance')
  list(@Query() query: Record<string, unknown>): Promise<{ items: CommissionRule[] }> {
    return this.rules.list(validateQuery<{ scope?: Scope }>('/commission-rules', 'get', query));
  }

  @Post()
  @Roles('system_admin')
  create(@Body() body: unknown, @Req() req: Request): Promise<CommissionRule> {
    return this.rules.create(req.principal!.userId, validateBody<CommissionRuleInput>('/commission-rules', 'post', body));
  }
}

