// Sticky-note colours, one per participant. All light enough for dark text (>= 4.5:1 against #22252a).
export const AUTHOR_COLORS = [
  '#ffeb3b', // yellow
  '#ff8a65', // coral
  '#4fc3f7', // sky
  '#81c784', // green
  '#ce93d8', // purple
  '#ffb74d', // orange
  '#f48fb1', // pink
  '#4db6ac', // teal
  '#d7ccc8', // tan
  '#9fa8da', // periwinkle
] as const;

// Fallback for an author missing from the participant list. FNV-1a keeps the spread even for similar ids.
export function authorColor(publicId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < publicId.length; i++) {
    h ^= publicId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return AUTHOR_COLORS[(h >>> 0) % AUTHOR_COLORS.length]!;
}

// Colours by join order (the snapshot lists participants oldest first), so everyone sees the same
// colour per person and the first AUTHOR_COLORS.length people never share one.
export function makeColorOf(participantIds: readonly string[]): (publicId: string) => string {
  const byId = new Map(participantIds.map((id, i) => [id, AUTHOR_COLORS[i % AUTHOR_COLORS.length]!]));
  return (publicId) => byId.get(publicId) ?? authorColor(publicId);
}
