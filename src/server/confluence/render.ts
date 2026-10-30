export type ExportData = {
  boardName: string;
  date: string;
  participants: string[];
  columns: { name: string; notes: { text: string; author: string; votes: number }[] }[];
  actionItems: { text: string; owner: string; noteText: string | null }[];
};

// Control characters other than tab/LF/CR, plus U+FFFE/U+FFFF, are not allowed in XML 1.0 at all.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Escapes the five XML special characters and drops characters XML 1.0 cannot represent. */
export function escapeXml(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes text and turns newlines into `<br/>`. */
function esc(s: string): string {
  return escapeXml(s).replace(/\r\n|\r|\n/g, '<br/>');
}

export function pageTitle(boardName: string, date: string): string {
  return `Retro – ${boardName} – ${date}`;
}

function votesText(n: number): string {
  return n === 1 ? '(1 vote)' : `(${n} votes)`;
}

export function renderStorage(d: ExportData): string {
  const parts: string[] = [];
  parts.push(`<p>${esc(d.date)} · Participants: ${esc(d.participants.join(', '))}</p>`);
  for (const col of d.columns) {
    parts.push(`<h2>${esc(col.name)}</h2>`);
    if (col.notes.length === 0) {
      parts.push('<p><em>No notes</em></p>');
    } else {
      const items = col.notes.map((n) => `<li>${esc(n.text)} — <em>${esc(n.author)}</em> ${votesText(n.votes)}</li>`);
      parts.push(`<ul>${items.join('')}</ul>`);
    }
  }
  parts.push('<h2>Action items</h2>');
  if (d.actionItems.length === 0) {
    parts.push('<p><em>No action items</em></p>');
  } else {
    const rows = d.actionItems.map(
      (a) => `<tr><td>${esc(a.text)}</td><td>${esc(a.owner)}</td><td>${a.noteText === null ? '' : esc(a.noteText)}</td></tr>`,
    );
    parts.push(
      `<table><tbody><tr><th>Item</th><th>Owner</th><th>From note</th></tr>${rows.join('')}</tbody></table>`,
    );
  }
  return parts.join('');
}
