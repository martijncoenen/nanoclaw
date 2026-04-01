import { createDecipheriv } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface GwsCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/**
 * Decrypt gws credentials from ~/.config/gws/credentials.enc using the
 * AES-256-GCM key stored in ~/.config/gws/.encryption_key.
 * Returns null if gws is not configured.
 */
export function decryptGwsCredentials(): GwsCredentials | null {
  const gwsDir = path.join(os.homedir(), '.config/gws');
  const encFile = path.join(gwsDir, 'credentials.enc');
  const keyFile = path.join(gwsDir, '.encryption_key');
  if (!fs.existsSync(encFile) || !fs.existsSync(keyFile)) return null;

  try {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    const enc = fs.readFileSync(encFile);
    const iv = enc.subarray(0, 12);
    const authTag = enc.subarray(-16);
    const ciphertext = enc.subarray(12, -16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString());
  } catch {
    return null;
  }
}
