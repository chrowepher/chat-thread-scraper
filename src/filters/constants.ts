export type FilterDeckKind = 'flag' | 'suggest';

export const FILTER_DECK_FILENAMES: Record<FilterDeckKind, string> = {
  flag: 'flagDeck.json',
  suggest: 'suggestDeck.json',
};

export const FILTER_DECK_VERSION = 1;

export const FILTER_CSV_COLUMNS = [
  'Deck',
  'ID',
  'Label',
  'Intent question',
  'Scope',
  'Signals to pull',
  'Output lens',
  'Priority',
  'Status',
  'Evidence floor',
  'Perspective pairing',
  'Insight quality',
  'Tags',
  'Trigger summary',
  'Notes',
  'Created at',
  'Updated at',
];
