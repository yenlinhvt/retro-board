import { z } from 'zod';

export type Config = {
  databaseUrl: string;
  port: number;
  trustProxy: boolean;
  publicBaseUrl: string;
  ownerSecret: string;
  inviteCodes: string[];
  sessionSecret: string;
  encryptionKey: Buffer;
  atlassian: { clientId: string; clientSecret: string } | null;
};

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.preprocess(blankToUndef, z.coerce.number().int().min(1).max(65535).default(3000)),
  TRUST_PROXY: z.preprocess(blankToUndef, z.enum(['true', 'false']).default('false')),
  PUBLIC_BASE_URL: z.string().url(),
  OWNER_SECRET: z.string().min(16),
  INVITE_CODES: z
    .string()
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1)),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z
    .string()
    .transform((s) => Buffer.from(s, 'base64'))
    .refine((b) => b.length === 32, 'must be base64 of exactly 32 bytes'),
  ATLASSIAN_CLIENT_ID: z.preprocess(blankToUndef, z.string().optional()),
  ATLASSIAN_CLIENT_SECRET: z.preprocess(blankToUndef, z.string().optional()),
});

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${String(i.path[0] ?? '?')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = r.data;
  const hasId = !!e.ATLASSIAN_CLIENT_ID;
  const hasSecret = !!e.ATLASSIAN_CLIENT_SECRET;
  if (hasId !== hasSecret) {
    throw new Error('Invalid configuration:\nATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET must be set together');
  }
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    trustProxy: e.TRUST_PROXY === 'true',
    publicBaseUrl: e.PUBLIC_BASE_URL,
    ownerSecret: e.OWNER_SECRET,
    inviteCodes: e.INVITE_CODES,
    sessionSecret: e.SESSION_SECRET,
    encryptionKey: e.ENCRYPTION_KEY,
    atlassian: hasId ? { clientId: e.ATLASSIAN_CLIENT_ID!, clientSecret: e.ATLASSIAN_CLIENT_SECRET! } : null,
  };
}
