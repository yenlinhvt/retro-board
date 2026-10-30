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

export function getIdentity(): { participantId: string; name: string | null } {
  let participantId = read(ID_KEY) ?? memory.participantId ?? null;
  if (!participantId) {
    participantId = crypto.randomUUID();
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
