import { describe, expect, it, vi } from "vitest";
import { speechKeyEncryption } from "../../../src/main/speech-key-encryption";

const native = () => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
  encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`cipher:${value}`)),
  decryptStringAsync: vi.fn(async () => ({ result: "private-fixture", shouldReEncrypt: true })),
});

describe("async desktop speech encryption", () => {
  it("is inert until demand, awaits availability, and rejects Linux basic_text", async () => {
    const storage = native();
    const encryption = speechKeyEncryption(storage, "linux");
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
    storage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    expect(await encryption.available()).toBe(false);
    expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled();
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    expect(await encryption.available()).toBe(true);
    const basic = { ...storage, getSelectedStorageBackend: () => "basic_text" as const };
    expect(await speechKeyEncryption(basic, "linux").available()).toBe(false);
    expect(await speechKeyEncryption(basic, "darwin").available()).toBe(true);
  });

  it("passes existing ciphertext unchanged and extracts plaintext, not the async result object", async () => {
    const storage = native();
    const encryption = speechKeyEncryption(storage, "darwin");
    const legacy = Uint8Array.from([118, 49, 48, 1, 255]);
    expect(await encryption.decrypt(legacy)).toBe("private-fixture");
    expect(storage.decryptStringAsync).toHaveBeenCalledWith(Buffer.from(legacy));
    // A key rotation hint is not permission to silently rewrite the saved document.
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(await encryption.encrypt("new-fixture")).toEqual(Buffer.from("cipher:new-fixture"));
    storage.decryptStringAsync.mockRejectedValue(new Error("native failure"));
    await expect(encryption.decrypt(legacy)).rejects.toThrow("native failure");
  });
});
