export const DEFAULT_COLUMNS = ['Went well', 'To improve', 'Ideas', 'Shout-outs'] as const satisfies readonly [string, string, string, string];

export const COLUMN_COUNT = 4;

export const LIMITS = {
  noteText: 1000,
  columnName: 60,
  boardName: 100,
  displayName: 40,
  actionText: 500,
  actionOwner: 60,
  voteLimitMin: 1,
  voteLimitMax: 50,
} as const;

export const DEFAULT_VOTE_LIMIT = 5;
