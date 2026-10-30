import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM; output is `iv.tag.ciphertext`, each base64url. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob: string, key: Buffer): string {
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('invalid ciphertext');
  const iv = Buffer.from(parts[0]!, 'base64url');
  const tag = Buffer.from(parts[1]!, 'base64url');
  const ct = Buffer.from(parts[2]!, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
