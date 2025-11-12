import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FilterDeckKind } from './constants.js';
import {
  FILTER_CSV_COLUMNS,
  FILTER_DECK_FILENAMES,
  FILTER_DECK_VERSION,
} from './constants.js';
import type { FilterDeck, FilterDeckSummary, FilterRow } from './types.js';

const DEFAULT_FILTER_DIR = path.join('notes', 'filter-decks');

const ISO_EPOCH = '2025-11-12T18:20:00.000Z';

const DEFAULT_FLAG_ROWS: FilterRow[] = [
  {
    id: 'flag-sro-housing-joburg',
    label: 'SRO housing in Johannesburg',
    intentQuestion:
      'What are the funding bottlenecks and policy levers for SRO builds in Joburg?',
    scope: 'Threads referencing South Africa, housing, or municipal policy.',
    signalsToPull:
      'Cost figures, municipal stakeholders, cited barriers, and enabling policies.',
    outputLens: 'Risk vs opportunity table plus unanswered questions list.',
    priority: 'high',
    status: 'active',
    evidenceFloor: 'Quote + source',
    perspectivePairing: 'City officials ↔ Private developers',
    tags: ['geo:ZA', 'topic:housing', 'lens:risk'],
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
    deck: 'flag',
    triggerSummary:
      'Pinned filter focused on Johannesburg relocation thread and housing policy levers.',
  },
];

const DEFAULT_SUGGEST_ROWS: FilterRow[] = [];

export interface FilterDeckStoreOptions {
  rootDir?: string;
}

export class FilterDeckStore {
  private readonly rootDir: string;

  constructor(options: FilterDeckStoreOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(process.cwd(), DEFAULT_FILTER_DIR);
  }

  async ensureInitialized(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await Promise.all(
      (Object.keys(FILTER_DECK_FILENAMES) as FilterDeckKind[]).map(async (kind) => {
        const deckPath = this.deckPath(kind);
        try {
          await fs.access(deckPath);
        } catch {
          const rows = kind === 'flag' ? DEFAULT_FLAG_ROWS : DEFAULT_SUGGEST_ROWS;
          const deck: FilterDeck = {
            kind,
            version: FILTER_DECK_VERSION,
            updatedAt: ISO_EPOCH,
            rows,
          };
          await this.writeDeck(kind, deck);
        }
      }),
    );
  }

  async summaries(): Promise<FilterDeckSummary[]> {
    const decks = await this.loadAllDecks();
    return decks.map((deck) => ({
      kind: deck.kind,
      rowCount: deck.rows.length,
      updatedAt: deck.updatedAt,
    }));
  }

  async loadDeck(kind: FilterDeckKind): Promise<FilterDeck> {
    await this.ensureInitialized();
    const deckPath = this.deckPath(kind);
    const raw = await fs.readFile(deckPath, 'utf8');
    const deck = JSON.parse(raw) as FilterDeck;
    deck.rows = deck.rows.map((row) => ({ ...row, deck: kind }));
    return deck;
  }

  async loadAllDecks(): Promise<FilterDeck[]> {
    return Promise.all(
      (Object.keys(FILTER_DECK_FILENAMES) as FilterDeckKind[]).map((kind) =>
        this.loadDeck(kind),
      ),
    );
  }

  async upsertRows(kind: FilterDeckKind, rows: FilterRow[]): Promise<FilterDeck> {
    const deck = await this.loadDeck(kind);
    const now = new Date().toISOString();
    const rowsById = new Map(deck.rows.map((row) => [row.id, row]));

    for (const row of rows) {
      const existing = row.id ? rowsById.get(row.id) : undefined;
      const id = row.id ?? randomUUID();
      const createdAt = existing?.createdAt ?? row.createdAt ?? now;
      const normalized: FilterRow = {
        ...row,
        id,
        createdAt,
        updatedAt: now,
        deck: kind,
      };
      rowsById.set(id, normalized);
    }

    const nextRows = Array.from(rowsById.values());
    deck.rows = nextRows;
    deck.updatedAt = now;
    await this.writeDeck(kind, deck);
    return deck;
  }

  async replaceDeck(kind: FilterDeckKind, rows: FilterRow[]): Promise<FilterDeck> {
    const now = new Date().toISOString();
    const normalizedRows = rows.map((row) => ({
      ...row,
      id: row.id ?? randomUUID(),
      deck: kind,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    }));
    const deck: FilterDeck = {
      kind,
      version: FILTER_DECK_VERSION,
      rows: normalizedRows,
      updatedAt: now,
    };
    await this.writeDeck(kind, deck);
    return deck;
  }

  async exportCsv(outputPath: string): Promise<void> {
    const decks = await this.loadAllDecks();
    const lines = [FILTER_CSV_COLUMNS.join(',')];
    for (const deck of decks) {
      for (const row of deck.rows) {
        const csvRow = this.serializeRowToCsv(deck.kind, row);
        lines.push(csvRow);
      }
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  }

  async writeDeck(kind: FilterDeckKind, deck: FilterDeck): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const deckPath = this.deckPath(kind);
    const payload = JSON.stringify(deck, null, 2);
    await fs.writeFile(deckPath, payload, 'utf8');
  }

  private deckPath(kind: FilterDeckKind): string {
    return path.join(this.rootDir, FILTER_DECK_FILENAMES[kind]);
  }

  private serializeRowToCsv(kind: FilterDeckKind, row: FilterRow): string {
    const fields = [
      kind,
      row.id,
      row.label,
      row.intentQuestion,
      row.scope,
      row.signalsToPull,
      row.outputLens,
      row.priority,
      row.status,
      row.evidenceFloor ?? '',
      row.perspectivePairing ?? '',
      row.insightQuality?.toString() ?? '',
      row.tags?.join('|') ?? '',
      row.triggerSummary ?? '',
      row.notes ?? '',
      row.createdAt,
      row.updatedAt,
    ];
    return fields.map(escapeCsv).join(',');
  }
}

const escapeCsv = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
