// API keys, encrypted at rest in this browser (AES-GCM with a non-extractable key kept in IndexedDB).
// Keeps keys out of plain localStorage; they never leave the browser except to the provider they belong to.

import { idb } from "../edge/idb";

const KEY_NAME = "secrets:key";

async function key(): Promise<CryptoKey> {
  let k = await idb.get<CryptoKey>(KEY_NAME);
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb.set(KEY_NAME, k);
  }
  return k;
}

export async function setSecret(name: string, value: string | null): Promise<void> {
  if (!value) return idb.del(`secret:${name}`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(value));
  await idb.set(`secret:${name}`, { iv, ct });
}

export async function getSecret(name: string): Promise<string | null> {
  const box = await idb.get<{ iv: Uint8Array; ct: ArrayBuffer }>(`secret:${name}`);
  if (!box) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, await key(), box.ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
