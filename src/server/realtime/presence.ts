export type Presence = {
  join(boardId: string, publicId: string): void;
  leave(boardId: string, publicId: string): void;
  online(boardId: string): Set<string>;
};

/** Ref-counted per publicId, so a participant with two tabs open counts once and stays online until both close. */
export function createPresence(): Presence {
  const boards = new Map<string, Map<string, number>>();
  return {
    join(boardId, publicId) {
      const counts = boards.get(boardId) ?? new Map<string, number>();
      counts.set(publicId, (counts.get(publicId) ?? 0) + 1);
      boards.set(boardId, counts);
    },
    leave(boardId, publicId) {
      const counts = boards.get(boardId);
      const n = counts?.get(publicId);
      if (!counts || n === undefined) return;
      if (n > 1) counts.set(publicId, n - 1);
      else counts.delete(publicId);
      if (counts.size === 0) boards.delete(boardId);
    },
    online(boardId) {
      return new Set(boards.get(boardId)?.keys() ?? []);
    },
  };
}
