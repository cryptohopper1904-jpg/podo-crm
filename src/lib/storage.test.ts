import { describe, expect, it, beforeAll, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readDecrypted, setStorageDriver, sniffMime, storeEncrypted } from "./storage";

describe("Verschlüsselte Ablage", () => {
  const files = new Map<string, Buffer>();
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    setStorageDriver({ put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)!, remove: async (k) => void files.delete(k) });
  });
  const org = "11111111-1111-1111-1111-111111111111";
  it("verschlüsselt und entschlüsselt", async () => {
    const data = Buffer.from("Fotodaten");
    const r = await storeEncrypted(org, data);
    expect(files.get(r.storageKey)!.includes(data)).toBe(false);
    expect((await readDecrypted(r.storageKey)).toString()).toBe("Fotodaten");
  });
  it("erkennt manipulierte Dateien und fremde Mandantenpfade", async () => {
    const r = await storeEncrypted(org, Buffer.from("x"));
    const other = r.storageKey.replace(org, "22222222-2222-2222-2222-222222222222");
    files.set(other, files.get(r.storageKey)!);
    await expect(readDecrypted(other)).rejects.toThrow();
  });
  it("erkennt Dateitypen an den Bytes", () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
});
