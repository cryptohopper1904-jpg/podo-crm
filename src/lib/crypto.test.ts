import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decrypt, decryptJson, encrypt, encryptJson, isEncrypted, loadKey } from "./crypto";

const keyB64 = randomBytes(32).toString("base64");

describe("crypto (AES-256-GCM)", () => {
  const original = process.env.APP_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = original;
  });

  it("verschlüsselt und entschlüsselt mit Env-Schlüssel", () => {
    process.env.APP_ENCRYPTION_KEY = keyB64;
    const enc = encrypt("geheimer-api-key-äöü");
    expect(enc).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(isEncrypted(enc)).toBe(true);
    expect(decrypt(enc)).toBe("geheimer-api-key-äöü");
  });

  it("erzeugt bei jedem Aufruf einen anderen Geheimtext (zufällige IV)", () => {
    const key = loadKey(keyB64);
    expect(encrypt("x", { key })).not.toBe(encrypt("x", { key }));
  });

  it("erkennt Manipulation und falschen Schlüssel", () => {
    const key = loadKey(keyB64);
    const enc = encrypt("hallo", { key });
    const parts = enc.split(":");
    const cipher = Buffer.from(parts[3], "base64");
    cipher[0] ^= 0xff;
    parts[3] = cipher.toString("base64");
    expect(() => decrypt(parts.join(":"), { key })).toThrow(/fehlgeschlagen/);
    expect(() => decrypt(enc, { key: randomBytes(32) })).toThrow(/fehlgeschlagen/);
  });

  it("bindet an AAD (Mandant)", () => {
    const key = loadKey(keyB64);
    const enc = encrypt("token", { key, aad: "org-1" });
    expect(decrypt(enc, { key, aad: "org-1" })).toBe("token");
    expect(() => decrypt(enc, { key, aad: "org-2" })).toThrow();
  });

  it("prüft Schlüssellänge und Format", () => {
    expect(() => loadKey("")).toThrow(/nicht gesetzt/);
    expect(() => loadKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 Byte/);
    expect(() => decrypt("v2:a:b:c", { key: loadKey(keyB64) })).toThrow(/Format/);
  });

  it("JSON-Hilfsfunktionen", () => {
    const key = loadKey(keyB64);
    const enc = encryptJson({ apiKey: "abc", merchantCode: "M1" }, { key });
    expect(decryptJson<{ apiKey: string }>(enc, { key }).apiKey).toBe("abc");
  });
});
