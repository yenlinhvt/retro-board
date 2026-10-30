import { describe, expect, test } from 'vitest';
import { escapeXml, pageTitle, renderStorage, type ExportData } from './render';

const data: ExportData = {
  boardName: 'Sprint 42',
  date: '2026-10-30',
  participants: ['Ann', 'Bob'],
  columns: [{ name: 'Went well', notes: [] }],
  actionItems: [],
};

describe('render', () => {
  test('title format', () => expect(pageTitle('Sprint 42', '2026-10-30')).toBe('Retro – Sprint 42 – 2026-10-30'));

  test('escapeXml escapes all five characters', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  test('escapes hostile text', () => {
    const xml = renderStorage({
      ...data,
      boardName: '<b>x</b>',
      participants: ['<i>Ann</i>'],
      columns: [{ name: 'A&B', notes: [{ text: '<script>x</script> ]]> 🎉\nline2', author: 'Ann', votes: 3 }] }],
    });
    expect(xml).toContain('A&amp;B');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('<b>x');
    expect(xml).toContain('&lt;i&gt;Ann&lt;/i&gt;');
    expect(xml).toContain(']]&gt;');
    expect(xml).toContain('🎉');
    expect(xml).toContain('<br/>');
    expect(xml).toContain('(3 votes)');
  });

  test('singular vote and note layout', () => {
    const xml = renderStorage({ ...data, columns: [{ name: 'C', notes: [{ text: 'hi', author: 'Ann', votes: 1 }] }] });
    expect(xml).toContain('<li>hi — <em>Ann</em> (1 vote)</li>');
  });

  test('renders action items table and empty-column placeholder', () => {
    const xml = renderStorage({
      ...data,
      actionItems: [
        { text: 'Fix\nit', owner: 'Bob & co', noteText: 'orig' },
        { text: 'Other', owner: '', noteText: null },
      ],
    });
    expect(xml).toContain('<p><em>No notes</em></p>');
    expect(xml).toContain('<h2>Action items</h2>');
    expect(xml).toContain('<th>Item</th><th>Owner</th><th>From note</th>');
    expect(xml).toContain('<td>Fix<br/>it</td><td>Bob &amp; co</td><td>orig</td>');
    expect(xml).toContain('<td>Other</td><td></td><td></td>');
  });

  test('no action items shows placeholder, not a table', () => {
    const xml = renderStorage(data);
    expect(xml).toContain('<p><em>No action items</em></p>');
    expect(xml).not.toContain('<table>');
  });
});
