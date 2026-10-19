import type { UploadForm } from '../../src/forms/dynamic-fields';
import type { Permission } from '../../src/identity/principal';
import { technicalTargetOnReceive } from '../../src/materials/material-store';
import { redactDynamicFields } from '../../src/materials/redaction';
import { TRANSITIONS, transitionOwners } from '../../src/materials/transitions';

// v0 يرفض الحقول الحساسة وحقول الموقع (البوابة)، فقاعدة الحجب تُختبر هنا بنموذج يتجاوز البوابة عمدًا.
const form = {
  version: 1,
  fields: [
    { key: 'notes', type: 'long_text', label: { ar: 'م', en: 'n' }, required: false },
    { key: 'source_name', type: 'short_text', label: { ar: 'م', en: 's' }, required: false, sensitive: true },
    { key: 'spot', type: 'location', label: { ar: 'م', en: 'l' }, required: false },
  ],
} as unknown as UploadForm;
const values = { notes: 'n', source_name: 'protected', spot: { lat: 1, lng: 2 } };

describe('redactDynamicFields (SEC-03)', () => {
  it('removes sensitive and location values without the permissions and lists their keys', () => {
    const r = redactDynamicFields(form, values, new Set());
    expect(r.fields).toEqual({ notes: 'n' });
    expect(r.redacted).toEqual(['source_name', 'spot']);
    expect(r.disclosed).toEqual([]);
  });

  it('each permission unlocks only its own field type, and disclosed keys are reported for audit', () => {
    const r = redactDynamicFields(form, values, new Set<Permission>(['protected_source:read']));
    expect(r.fields).toEqual({ notes: 'n', source_name: 'protected' });
    expect(r.redacted).toEqual(['spot']);
    expect(r.disclosed).toEqual(['source_name']);
    const both = redactDynamicFields(form, values, new Set<Permission>(['protected_source:read', 'sensitive_location:read']));
    expect(both.redacted).toEqual([]);
    expect(both.disclosed).toEqual(['source_name', 'spot']);
  });

  it('without the form version nothing is interpreted, so nothing is returned', () => {
    expect(redactDynamicFields(undefined, values, new Set()).fields).toEqual({});
  });
});

describe('transition table', () => {
  it('matches the contract table (spot checks) and rejects everything else', () => {
    expect(transitionOwners('editorial', 'inbox', 'acknowledged')).toEqual(['supervisor']);
    expect(transitionOwners('editorial', 'accepted', 'in_production')).toEqual(['reservation']);
    expect(transitionOwners('technical', 'failed', 'pending')).toEqual(['reporter_owner']);
    expect(transitionOwners('rights', 'sellable', 'withdrawn')).toEqual(['rights_officer', 'editor_in_chief']);
    expect(transitionOwners('editorial', 'inbox', 'published')).toBeUndefined();
    expect(transitionOwners('rights', 'withdrawn', 'documented')).toBeUndefined();
    // 8 فنية + 14 تحريرية + 6 حقوق كما في جدول العقد
    expect(TRANSITIONS.reduce((n, r) => n + r.to.length, 0)).toBe(28);
  });

  it('uploads drive the technical track forward only', () => {
    expect(technicalTargetOnReceive('proxy', 'pending')).toBe('proxy_received');
    expect(technicalTargetOnReceive('original', 'proxy_received')).toBe('original_received');
    expect(technicalTargetOnReceive('proxy', 'original_received')).toBeUndefined();
    expect(technicalTargetOnReceive('voice_note', 'pending')).toBeUndefined();
  });
});
