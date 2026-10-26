import { getTableName, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { acknowledgementDue, staffWorkName, workNameFor } from '../../src/common/design-fields';
import { CatalogService } from '../../src/commerce/catalog.service';
import { licenseTerms } from '../../src/commerce/license-templates.service';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { schemaValidator } from '../../src/common/contract';
import type { Principal } from '../../src/identity/principal';

const principal = (role: Principal['roles'][number]['role']): Principal => ({userId:'synthetic',officeId:null,organizationId:null,permissions:new Set(),roles:[{role,scopeKind:'all',scopeId:''}]});
const dialect = new PgDialect();
describe('ADR 0035 computed fields', () => {
  it.each(['reserved_by_name','actor_name'])('%s hides names from reporters, buyers and missing names', () => {
    expect(workNameFor(principal('supervisor'),'اصطناعي')).toBe('اصطناعي');
    for(const role of ['reporter','buyer_admin','buyer_member'] as const) expect(workNameFor(principal(role),'اصطناعي')).toBeNull();
    expect(workNameFor(principal('system_admin'),null)).toBeNull();
    const query=dialect.sqlToQuery(staffWorkName(sql`subject_id`)).sql;
    expect(query).toContain('organization_id IS NULL');expect(query).toContain("'reporter'");
    expect(query).not.toContain('legal_name');expect(query).not.toContain('email');
  });
  it('acknowledgement_due_at selects the earliest unacknowledged assignment for the selected material', () => {
    const query=dialect.sqlToQuery(acknowledgementDue(sql`selected_material`)).sql;
    expect(query).toContain('min(n.escalate_at)');expect(query).toContain('n.material_id = selected_material');
    expect(query).toContain("assignment_state = 'assigned'");expect(query).toContain('acknowledged_at IS NULL');
  });
  it('oldest_overdue_acknowledgement_at and reservation name survive dashboard mapping', async () => {
    const due='2026-01-01T00:00:00Z';
    const db:any={execute:async()=>({rows:[]}),select:()=>{
      let table='';const b:any={from:(t:any)=>{table=getTableName(t);return b;},then:(resolve:any)=>resolve(table==='notifications'?[{n:1,oldest:due}]:table==='materials'?[{material_id:'m',reserved_by:'u',reserved_by_name:'اصطناعي',reserved_at:due,priority:'normal',editorial_state:'inbox'}]:[])};
      for(const method of ['innerJoin','leftJoin','where','orderBy','limit'])b[method]=()=>b;return b;
    }};
    const svc=new DashboardService(db,{DASHBOARD_SNAPSHOT_MS:0} as never);
    const result=await svc.newsroom(principal('supervisor'));
    expect(result.oldest_overdue_acknowledgement_at).toBe('2026-01-01T00:00:00.000Z');expect(result.reserved[0]?.reserved_by_name).toBe('اصطناعي');
  });
  it.each(['verified_on','editorial_approved_on','editorial_approver_role','exclusive_unavailable_until'])('%s maps only the computed whitelist column, not private row fields', async field => {
    const row:any={id:'listing',material_version:1,title_ar:'a',title_en:'e',description_ar:'a',description_en:'e',shot_list:[],material_types:['report'],governorate:'gaza',shot_on:null,duration_ms:null,width:null,height:null,listed_at:'2026-01-01T00:00:00Z',verified_on:'2026-01-01',editorial_approved_on:'2026-01-02',editorial_approver_role:'supervisor',exclusive_unavailable_until:'2026-02-01T00:00:00.000Z',exclusive_blocked:true,work_name:'private',sha256:'private'};
    const db:any={execute:async()=>({rows:[row]}),select:()=>({from:()=>({where:async()=>[]})})};
    const svc=new CatalogService(db,{CATALOG_CREDIT:'شبكة اصطناعية'} as never,{} as never);
    const dto=(await svc.search({})).items[0]!;
    expect((dto as any)[field]).toBe(row[field]);expect(dto.exclusive_available).toBe(false);
    expect(dto).not.toHaveProperty('work_name');expect(dto).not.toHaveProperty('sha256');
    expect(dto).not.toHaveProperty('exclusive_blocked');
  });
  it('terms share the frozen license whitelist with the offer, without template author or price', () => {
    const v:any={templateId:'private',version:3,type:'editorial_single',nameAr:'اصطناعي',nameEn:'Synthetic',termsAr:'شروط',termsEn:'Terms',usageMedia:['web'],territoryKind:'worldwide',termDays:null,exclusivityHours:null,deliverables:['original'],attributionAr:'شبكة',attributionEn:'Network',prohibitions:[],basePriceMinor:100,currency:'USD',enabled:true,createdAt:'2026-01-01T00:00:00Z',createdBy:'private'};
    const terms=licenseTerms(v);expect(schemaValidator('LicenseTerms')(terms)).toBe(true);
    expect(terms.terms).toEqual({ar:'شروط',en:'Terms'});expect(JSON.stringify(terms)).not.toContain('private');
    expect(terms).not.toHaveProperty('created_by');expect(terms).not.toHaveProperty('base_price');
  });
});
