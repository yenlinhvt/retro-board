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

  test('escapeXml strips characters that are invalid in XML 1.0', () => {
    const bad = '\u0000\u0001\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF';
    expect(escapeXml(`a${bad}b\tc\nd\re é 🎉`)).toBe('ab\tc\nd\re é 🎉');
    expect(renderStorage({ ...data, boardName: 'x', columns: [{ name: `W\u0007ell`, notes: [] }] })).toContain('<h2>Well</h2>');
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
    expect(xml).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
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

  test('intro names the board, date and participants', () => {
    expect(renderStorage(data).startsWith('<p><strong>Sprint 42</strong> · 2026-10-30 · Participants: Ann, Bob</p>')).toBe(true);
  });

  test('no action items shows placeholder, not a table', () => {
    const xml = renderStorage(data);
    expect(xml).toContain('<p><em>No action items</em></p>');
    expect(xml).not.toContain('<table>');
  });
});
