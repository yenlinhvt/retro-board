import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test/helpers';
import { boards, notes, participants } from './schema';

describe('schema', () => {
  test('migrations apply and cascade delete removes children', async () => {
    const db = await createTestDb();
    await db.insert(boards).values({ id: 'b1', name: 'B', adminTokenHash: 'h', columns: ['a', 'b', 'c', 'd'] });
    await db.insert(participants).values({ id: 'p1', boardId: 'b1', clientId: 'c1', publicId: 'pub1', name: 'Ann' });
    await db.insert(notes).values({ id: 'n1', boardId: 'b1', authorId: 'p1', columnIndex: 0, text: 'hi' });
    await db.delete(boards).where(eq(boards.id, 'b1'));
    expect(await db.select().from(notes)).toHaveLength(0);
  });
});
