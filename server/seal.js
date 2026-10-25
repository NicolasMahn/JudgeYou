// Kept chats are locked with a public key. The server holds only that key, so
// it can store chats but not read them; the private key stays on the
// operator's own machine. A stolen database or backup is unreadable.
//
// RSA can only encrypt a few hundred bytes, so each chat gets its own random
// AES key, and only that key is locked with RSA.
import { createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';

const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Layout: 2-byte length of the locked key, locked key, IV, auth tag, ciphertext. */
export function seal(plaintext, publicKey) {
  const key = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const lockedKey = publicEncrypt({ key: publicKey, ...OAEP }, key);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(lockedKey.length);
  return Buffer.concat([length, lockedKey, iv, cipher.getAuthTag(), data]);
}

export function unseal(sealed, privateKey) {
  const keyLength = sealed.readUInt16BE(0);
  let at = 2;
  const take = (bytes) => sealed.subarray(at, (at += bytes));
  const key = privateDecrypt({ key: privateKey, ...OAEP }, take(keyLength));
  const iv = take(IV_BYTES);
  const tag = take(TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv).setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(at)), decipher.final()]).toString('utf8');
}
