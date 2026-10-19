import type { RoleName } from '../identity/principal';

export type Track = 'technical' | 'editorial' | 'rights';

/**
 * من يملك الانتقال: دور (ضمن نطاقه)، أو المراسل صاحب المادة، أو المنتج الحاجز، أو الخادم وحده،
 * أو الحجز (POST /materials/{id}/reservation) لا مسار الانتقالات.
 */
export type Owner = RoleName | 'reporter_owner' | 'reservation_holder' | 'server' | 'reservation';

interface Rule {
  track: Track;
  from: string;
  to: string[];
  by: Owner[];
}

// جدول الانتقالات المسموحة في v0 كما في العقد (POST /materials/{id}/transitions). ما ليس هنا = 409 invalid_transition.
export const TRANSITIONS: readonly Rule[] = [
  { track: 'technical', from: 'pending', to: ['proxy_received', 'original_received', 'failed'], by: ['server'] },
  { track: 'technical', from: 'proxy_received', to: ['original_received', 'failed'], by: ['server'] },
  { track: 'technical', from: 'original_received', to: ['verified', 'failed'], by: ['server'] },
  { track: 'technical', from: 'failed', to: ['pending'], by: ['reporter_owner'] },
  { track: 'editorial', from: 'inbox', to: ['acknowledged', 'rejected'], by: ['supervisor'] },
  { track: 'editorial', from: 'acknowledged', to: ['reviewing', 'rejected'], by: ['supervisor'] },
  { track: 'editorial', from: 'reviewing', to: ['needs_changes', 'accepted', 'rejected'], by: ['supervisor'] },
  { track: 'editorial', from: 'needs_changes', to: ['reviewing'], by: ['reporter_owner'] },
  { track: 'editorial', from: 'accepted', to: ['in_production'], by: ['reservation'] },
  { track: 'editorial', from: 'in_production', to: ['final_review', 'accepted'], by: ['reservation_holder'] },
  { track: 'editorial', from: 'final_review', to: ['published', 'in_production'], by: ['editor_in_chief'] },
  { track: 'editorial', from: 'published', to: ['final_review'], by: ['editor_in_chief'] },
  { track: 'rights', from: 'unknown', to: ['documented'], by: ['rights_officer'] },
  { track: 'rights', from: 'documented', to: ['sellable', 'blocked'], by: ['rights_officer'] },
  { track: 'rights', from: 'sellable', to: ['blocked', 'withdrawn'], by: ['rights_officer', 'editor_in_chief'] },
  { track: 'rights', from: 'blocked', to: ['documented'], by: ['rights_officer'] },
];

/** مالكو الانتقال إن كان مسموحًا، وإلا undefined. */
export function transitionOwners(track: Track, from: string, to: string): Owner[] | undefined {
  return TRANSITIONS.find((r) => r.track === track && r.from === from && r.to.includes(to))?.by;
}

export const STATE_COLUMN = { technical: 'technicalState', editorial: 'editorialState', rights: 'rightsState' } as const;

/** الحالات التحريرية التي يكون التعديل فيها تعديلًا لإصدار معتمد (يرفع version ويعيد إلى final_review). */
export const APPROVED_STATES = ['accepted', 'in_production', 'final_review', 'published'] as const;
/** ما يراه الإنتاج: «المواد المقبولة للإنتاج» فما بعدها. */
export const PRODUCTION_VISIBLE_STATES = APPROVED_STATES;
