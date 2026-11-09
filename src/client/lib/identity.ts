const ID_KEY = 'retro.participantId';
const NAME_KEY = 'retro.name';

const memory: { participantId?: string; name?: string | null } = {};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: in-memory fallback is used */
  }
}

/** A random UUID v4. `crypto.randomUUID` is missing outside secure contexts (plain http), so fall back to getRandomValues. */
export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getIdentity(): { participantId: string; name: string | null } {
  let participantId = read(ID_KEY) ?? memory.participantId ?? null;
  if (!participantId) {
    participantId = uuidV4();
    write(ID_KEY, participantId);
  }
  memory.participantId = participantId;
  const name = read(NAME_KEY) ?? memory.name ?? null;
  return { participantId, name };
}

export function setName(name: string): void {
  memory.name = name;
  write(NAME_KEY, name);
}
