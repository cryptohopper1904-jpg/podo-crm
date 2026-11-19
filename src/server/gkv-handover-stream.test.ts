/**
 * Nachdruck als Stream (streamArchive) ohne Datenbank: Ein verändertes Archiv (Chiffretext oder GCM-Tag) darf nie
 * vollständig ausgeliefert werden – der Stream liefert weniger Bytes als das Original und endet mit einem Fehler.
 * Ablage über den lokalen Speicher-Treiber im temporären STORAGE_DIR (vitest.setup.ts), erfundene Daten.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

let storage: typeof import("@/lib/storage");
let ho: typeof import("./gkv-handover");

beforeAll(async () => {
  storage = await import("@/lib/storage");
  ho = await import("./gkv-handover");
});

/** Kopf der Ablage: 5 Byte Format + 12 Byte IV + 16 Byte GCM-Tag (src/lib/storage.ts) */
const TAG_OFFSET = 17;
const HEADER_BYTES = 33;

function* chunked(b: Buffer, size = 16 * 1024) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

async function drain(s: Readable): Promise<{ bytes: number; error: unknown }> {
  let bytes = 0;
  try {
    for await (const chunk of s) bytes += (chunk as Buffer).length;
    return { bytes, error: null };
  } catch (e) {
    return { bytes, error: e };
  }
}

/** Archiv ablegen (größer als ein 64-KB-Leseblock, damit vor dem Fehler schon Daten fließen) und ein Byte kippen */
async function storedArchive(flipAt: (fileSize: number) => number) {
  const org = randomUUID();
  const data = randomBytes(300 * 1024);
  const stored = await storage.storeEncrypted(org, data);
  const file = path.join(process.env.STORAGE_DIR!, stored.storageKey);
  const raw = readFileSync(file);
  raw[flipAt(raw.length)] ^= 0x01;
  writeFileSync(file, raw);
  return { org, data, archive: { storageKey: stored.storageKey, sha256: stored.sha256 } };
}

describe("streamArchive – manipuliertes Archiv", () => {
  it("unverändertes Archiv: vollständig und ohne Fehler (Gegenprobe)", async () => {
    const org = randomUUID();
    const data = randomBytes(300 * 1024);
    const stored = await storage.storeEncrypted(org, data);
    const chunks: Buffer[] = [];
    for await (const c of ho.streamArchive(org, stored)) chunks.push(c as Buffer);
    const out = Buffer.concat(chunks);
    expect(out.length).toBe(data.length);
    expect(createHash("sha256").update(out).digest("hex")).toBe(stored.sha256);
  });

  it("gekipptes Byte im Chiffretext: weniger Bytes als das Original, Stream endet mit Fehler", async () => {
    const { org, data, archive } = await storedArchive((size) => HEADER_BYTES + Math.floor((size - HEADER_BYTES) / 2));
    const r = await drain(ho.streamArchive(org, archive));
    expect(r.error).toBeInstanceOf(Error);
    expect(r.bytes).toBeLessThan(data.length);
  });

  it("gekipptes Byte im GCM-Tag: weniger Bytes als das Original, Stream endet mit Fehler", async () => {
    const { org, data, archive } = await storedArchive(() => TAG_OFFSET + 3);
    const r = await drain(ho.streamArchive(org, archive));
    expect(r.error).toBeInstanceOf(Error);
    expect(r.bytes).toBeLessThan(data.length);
  });

  it("gekipptes Byte im letzten Block: der zurückgehaltene Rest fehlt, Fehler am Ende", async () => {
    const { org, data, archive } = await storedArchive((size) => size - 1);
    const r = await drain(ho.streamArchive(org, archive));
    expect(r.error).toBeInstanceOf(Error);
    expect(r.bytes).toBeLessThan(data.length);
  });

  // zuletzt: ersetzt den Speicher-Treiber dieser Testdatei
  it("Abbruch durch den Empfänger beendet auch das Lesen der Datei (pipeline räumt beide Seiten auf)", async () => {
    const files = new Map<string, Buffer>();
    const sources: Readable[] = [];
    storage.setStorageDriver({
      put: async (k, d) => void files.set(k, d),
      get: async (k) => files.get(k)!,
      getStream: (k) => {
        const s = Readable.from(chunked(files.get(k)!), { objectMode: false });
        sources.push(s);
        return s;
      },
      remove: async (k) => void files.delete(k),
    });
    const org = randomUUID();
    const stored = await storage.storeEncrypted(org, randomBytes(300 * 1024));
    const s = ho.streamArchive(org, stored);
    await new Promise<void>((resolve) => s.once("data", () => resolve()));
    s.destroy();
    await new Promise<void>((resolve) => (s.closed ? resolve() : s.once("close", () => resolve())));
    await vi.waitFor(() => expect(sources[0]?.destroyed).toBe(true));
  });
});
