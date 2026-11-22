// Authenticated encryption helpers (AES-256-GCM, 96-bit random IV, 128-bit tag) and the credential
// format: cred_blob = "v2:" + base64(iv | tag | ciphertext), key = HKDF(DEK, "mc/cred/v2"),
// AAD = "cred|v2|<connection uuid>|<company id>" so a blob only decrypts in its own row.
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { subkey } from './keys.js';

const IV = 12;
const TAG = 16;

export function seal(key, plain, aad) {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Returns the plaintext Buffer (caller zeroes it). Throws on any tampering. */
export function open(key, sealed, aad) {
  if (!Buffer.isBuffer(sealed) || sealed.length < IV + TAG) throw new Error('DECRYPT_FAILED');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV), { authTagLength: TAG });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()]);
}

const credAad = (uuid, companyId) => {
  if (typeof uuid !== 'string' || !uuid) throw new Error('missing credential uuid');
  return `cred|v2|${uuid}|${companyId}`;
};

export const isSealedCredential = (blob) => typeof blob === 'string' && blob.startsWith('v2:');

/** Seal a credentials object. */
export function sealCredentials(obj, { uuid, companyId }) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  try {
    return `v2:${seal(subkey('mc/cred/v2'), plain, credAad(uuid, companyId)).toString('base64')}`;
  } finally {
    plain.fill(0);
  }
}

/** Seal plaintext JSON bytes (used by the v1 -> v2 migration; never parses them). */
export function sealCredentialBytes(plain, { uuid, companyId }) {
  return `v2:${seal(subkey('mc/cred/v2'), plain, credAad(uuid, companyId)).toString('base64')}`;
}

/** Decrypt a v2 blob to its JSON bytes (Buffer; caller zeroes it). */
export function openCredentialBytes(blob, { uuid, companyId }) {
  if (!isSealedCredential(blob)) throw new Error('DECRYPT_FAILED');
  return open(subkey('mc/cred/v2'), Buffer.from(blob.slice(3), 'base64'), credAad(uuid, companyId));
}

/** Decrypt a v2 blob to the credentials object. */
export function openCredentials(blob, ids) {
  const buf = openCredentialBytes(blob, ids);
  try { return JSON.parse(buf.toString('utf8')); } finally { buf.fill(0); }
}

/** Keyed index for full account numbers (never stored in clear). */
export function accountKey(accountNumber) {
  return `h:${createHmac('sha256', subkey('mc/index/v1')).update(String(accountNumber)).digest('hex')}`;
}
