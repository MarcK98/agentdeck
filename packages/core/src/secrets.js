// Symmetric encryption for per-project MCP secrets (the tokens users paste on
// the settings page). Ciphertext lives in SQLite (project_secrets, v4); the
// key does NOT — it sits in a 0600 keyfile beside the db, so copying spawn.db
// alone never yields plaintext.
//
// AES-256-GCM (authenticated). The daemon is plain Node (not Electron), so
// safeStorage/keytar aren't available; a keyfile + AES-GCM is the right fit and
// adds no native deps. Packed value = base64(iv[12] | tag[16] | ciphertext).

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dataPath } from "./config.js";

const KEY_FILE = dataPath("spawn-secret.key");
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey = null;

// 32-byte key, created on first use (0600). Cached for the process lifetime.
function key() {
  if (cachedKey) return cachedKey;
  if (existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_FILE, cachedKey.toString("hex"), { mode: 0o600 });
    chmodSync(KEY_FILE, 0o600); // enforce even if the file pre-existed with a looser umask
  }
  if (cachedKey.length !== 32) throw new Error("spawn-secret.key is malformed (expected 32 bytes hex)");
  return cachedKey;
}

// plaintext -> packed base64. Empty/nullish returns "" (caller treats as unset).
export function encrypt(plain) {
  if (plain == null || plain === "") return "";
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

// packed base64 -> plaintext. Returns null on any tamper/corruption/decode
// failure rather than throwing — a bad row must not wedge a run's assembly.
export function decrypt(packed) {
  if (!packed) return null;
  try {
    const buf = Buffer.from(packed, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
