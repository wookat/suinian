export interface BlindCarrier {
  id: string;
  family?: string;
  note: string;
  secrets: string[];
  topic: string;
  asks?: string[];
}
export interface BlindBenign {
  id: string;
  note: string;
  ask: string;
  expect: string[];
  kind: string;
}
export interface BlindVerbatim {
  id: string;
  ref: string;
  ask: string;
  expect: string[];
}
export const BUILT_AT: string;
export const GENERIC_ASKS: Record<string, string>;
export const CARRIERS: BlindCarrier[];
export const MULTI_TURN: Record<string, string[]>;
export const ORACLE_ASKS: string[];
export const BENIGN: BlindBenign[];
export const VERBATIM_RECALL: BlindVerbatim[];
export const SUPPLEMENT: BlindCarrier[];
