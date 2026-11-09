import type { SafeStorage } from "electron";
import type { SpeechKeyEncryption } from "../services/speech/SpeechOutputStorageLive";

/** No keychain work at construction. Electron owns lazy async encryptor initialization.
 * Existing sync ciphertext is accepted by decryptStringAsync; the next explicit save
 * uses the current async key. Reading does not silently rewrite credential storage.
 */
export const speechKeyEncryption = (
  storage: Pick<
    SafeStorage,
    | "isAsyncEncryptionAvailable"
    | "getSelectedStorageBackend"
    | "encryptStringAsync"
    | "decryptStringAsync"
  >,
  platform: NodeJS.Platform = process.platform,
): SpeechKeyEncryption => ({
  available: async () =>
    (await storage.isAsyncEncryptionAvailable()) &&
    (platform !== "linux" || storage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (plaintext) => storage.encryptStringAsync(plaintext),
  decrypt: async (ciphertext) => (await storage.decryptStringAsync(Buffer.from(ciphertext))).result,
});
