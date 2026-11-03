import { ASSIGNMENT_TRANSITIONS, assignmentTransitionOwners, canAssign, CLOSED_STATES, OPEN_STATES, toAssignmentDto } from '../../src/assignments/assignment-store';
import type { AssignmentView } from '../../src/assignments/assignment-store';
import { componentSchema } from '../../src/common/contract';
import type { Principal, RoleGrant } from '../../src/identity/principal';
import type { MaterialRow } from '../../src/materials/material-store';

const principal = (roles: RoleGrant[], over: Partial<Principal> = {}): Principal => ({
  userId: 'u',
  officeId: null,
  organizationId: null,
  roles,
  permissions: new Set(),
  ...over,
});
const material = { officeId: 'office-1', officeGovernorate: 'محافظة' } as MaterialRow;

// جدول انتقالات المهمة (ADR 0096)
describe('assignment transitions', () => {
  const states = componentSchema('MaterialAssignmentState').enum as string[];

  it('covers exactly the table: forward for the assignee, return for both, nothing out of done or returned', () => {
    const allowed = new Map<string, readonly string[]>();
    for (const from of states) for (const to of states) {
      const owners = assignmentTransitionOwners(from, to);
      if (owners) allowed.set(`${from}→${to}`, owners);
    }
    expect(Object.fromEntries(allowed)).toEqual({
      'assigned→acknowledged': ['assignee'],
      'assigned→in_progress': ['assignee'],
      'assigned→returned': ['assignee', 'manager'],
      'acknowledged→in_progress': ['assignee'],
      'acknowledged→returned': ['assignee', 'manager'],
      'in_progress→done': ['assignee'],
      'in_progress→returned': ['assignee', 'manager'],
    });
    expect(ASSIGNMENT_TRANSITIONS.length).toBe(allowed.size);
  });

  it('has no cycle, so each (assignment, target state) happens once and its event key is deterministic', () => {
    for (const t of ASSIGNMENT_TRANSITIONS) {
      expect(states.indexOf(t.to)).toBeGreaterThan(states.indexOf(t.from));
      expect(ASSIGNMENT_TRANSITIONS.some((u) => u.from === t.to && u.to === t.from)).toBe(false);
    }
  });

  it('open and closed states partition the contract enum, and the transition request targets match it', () => {
    expect([...OPEN_STATES, ...CLOSED_STATES].sort()).toEqual([...states].sort());
    const targets = (componentSchema('AssignmentTransition').properties as Record<string, { enum?: string[] }>).to!.enum!;
    expect([...new Set(ASSIGNMENT_TRANSITIONS.map((t) => t.to))].sort()).toEqual([...targets].sort());
  });
});

describe('canAssign', () => {
  it('the editor-in-chief everywhere and a supervisor within scope only; producers never', () => {
    expect(canAssign(principal([{ role: 'editor_in_chief', scopeKind: 'all', scopeId: '' }]), material)).toBe(true);
    expect(canAssign(principal([{ role: 'supervisor', scopeKind: 'office', scopeId: 'office-1' }]), material)).toBe(true);
    expect(canAssign(principal([{ role: 'supervisor', scopeKind: 'governorate', scopeId: 'محافظة' }]), material)).toBe(true);
    expect(canAssign(principal([{ role: 'supervisor', scopeKind: 'office', scopeId: 'office-2' }]), material)).toBe(false);
    expect(canAssign(principal([{ role: 'producer', scopeKind: 'all', scopeId: '' }]), material)).toBe(false);
    expect(canAssign(principal([{ role: 'system_admin', scopeKind: 'all', scopeId: '' }]), material)).toBe(false);
  });
});

describe('toAssignmentDto', () => {
  const row = {
    id: 'a',
    materialId: 'm',
    assigneeId: 'p',
    assignedBy: 's',
    state: 'assigned',
    dueAt: '2026-11-03T15:00:00Z',
    note: null,
    returnedBy: null,
    returnNote: null,
    createdAt: '2026-11-03T14:30:00Z',
    acknowledgedAt: null,
    startedAt: null,
    closedAt: null,
    updatedAt: '2026-11-03T14:30:00Z',
    priority: 'urgent',
    assigneeName: 'مونتير تجريبي ١',
    assignedByName: null,
    overdue: false,
  } as AssignmentView;

  it('gives work names to staff and leaves the keys out for anyone who may not see them', () => {
    const staff = toAssignmentDto(principal([{ role: 'producer', scopeKind: 'all', scopeId: '' }]), row);
    expect(staff).toMatchObject({ assignee_name: 'مونتير تجريبي ١', assigned_by_name: null, due_at: '2026-11-03T15:00:00.000Z' });
    const mixed = toAssignmentDto(principal([{ role: 'producer', scopeKind: 'all', scopeId: '' }, { role: 'reporter', scopeKind: 'all', scopeId: '' }]), row);
    expect(mixed).not.toHaveProperty('assignee_name');
    expect(mixed).not.toHaveProperty('assigned_by_name');
  });
});
