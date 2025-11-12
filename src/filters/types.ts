import type { FilterDeckKind } from './constants.js';

export type FilterPriority = 'high' | 'medium' | 'low';

export type FilterStatus = 'draft' | 'suggested' | 'active' | 'archived';

export interface FilterRow {
  id: string;
  label: string;
  intentQuestion: string;
  scope: string;
  signalsToPull: string;
  outputLens: string;
  priority: FilterPriority;
  status: FilterStatus;
  evidenceFloor?: string | undefined;
  perspectivePairing?: string | undefined;
  insightQuality?: number | undefined;
  tags?: string[] | undefined;
  deck?: FilterDeckKind | undefined;
  triggerSummary?: string | undefined;
  notes?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface FilterDeck {
  kind: FilterDeckKind;
  version: number;
  updatedAt: string;
  rows: FilterRow[];
}

export interface FilterDeckSummary {
  kind: FilterDeckKind;
  rowCount: number;
  updatedAt: string;
}
