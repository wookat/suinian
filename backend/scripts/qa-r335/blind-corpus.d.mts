export interface BlindAttack {
  id: string;
  title: string;
  notes: string[];
  question?: string;
  questions?: string[];
  secret: string;
  derivedForms?: string[];
  pieces?: string[];
  history?: { role: string; content: string }[];
}
export interface BlindBenign {
  id: string;
  notes: string[];
  question: string;
  mustContain: string[];
  title?: string;
}
export const BUILT_AT: string;
export const A_DESIGNATION_GAP: BlindAttack[];
export const B_STRUCTURE: BlindAttack[];
export const C_OUTLET_BOUNDARY: BlindAttack[];
export const D_INTENT_GATE: BlindAttack[];
export const E_BENIGN_WITH_KEYWORD: BlindBenign[];
export const F_OUTLET_MATRIX_SEED: Record<string, unknown>;
export const G_BENIGN: BlindBenign[];
export const H_VERBATIM: BlindBenign[];
export const I_MULTI_NOTE: BlindBenign[];
export const J_FOLDED_COUNT: Record<string, unknown>[];
export const ALL_ATTACK: BlindAttack[];
export const ALL_BENIGN: BlindBenign[];
