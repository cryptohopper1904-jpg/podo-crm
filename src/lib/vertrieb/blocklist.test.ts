import { describe, expect, it } from "vitest";
import { blockEntriesForLead, blockHash, blocklistHash, blocklistKeyCheck, hashedEmailSet } from "./blocklist";
import { buildDedupeKeys, duplicateBeforeEmail } from "./lead-search";

const key = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);

describe("Sperrliste als Prüfwert", () => {
  it("nicht umkehrbar, normalisiert, schlüsselabhängig", () => {
    const h = blocklistHash("Info@Praxis.example ", key);
    expect(h).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(h).not.toContain("praxis");
    expect(blocklistHash("info@praxis.example", key)).toBe(h);
    expect(blocklistHash("info@praxis.example", other)).not.toBe(h);
    expect(blocklistHash("info2@praxis.example", key)).not.toBe(h);
  });
  it("Abgleich über has(email)", () => {
    const set = hashedEmailSet([blocklistHash("a@b.example", key)], key);
    expect(set.has("A@B.example")).toBe(true);
    expect(set.has("c@b.example")).toBe(false);
  });
});

describe("Sperrliste: Website und Name+PLZ, Kanarienwert", () => {
  it("Arten getrennt, Abgleich normalisiert", () => {
    const entries = blockEntriesForLead({ email: "a@b.example", website: "https://www.praxis.example/x", name: "Podologie  Muster", zip: "12345" }, key);
    expect(entries.map((e) => e.kind)).toEqual(["email", "host", "namezip"]);
    expect(blockHash("host", "praxis.example", key)).not.toBe(blocklistHash("praxis.example", key));
    const m = hashedEmailSet(entries.map((e) => e.hash), key);
    expect(m.hasHost("http://praxis.example")).toBe(true);
    expect(m.hasHost("https://andere.example")).toBe(false);
    expect(m.hasNameZip("podologie muster", "12345")).toBe(true);
    expect(m.hasNameZip("Podologie Muster", null)).toBe(false);
    // Praxissuche: abgemeldete Praxis wird vor dem Website-Abruf erkannt
    const k = buildDedupeKeys([], m);
    expect(duplicateBeforeEmail(k, { name: "Podologie Muster", zip: "12345", website: null })).toMatch(/Sperrliste/);
    expect(duplicateBeforeEmail(k, { name: "Neu", zip: "1", website: "https://www.praxis.example" })).toMatch(/Sperrliste/);
    expect(duplicateBeforeEmail(k, { name: "Neu", zip: "1", website: null })).toBeNull();
  });
  it("Kanarienwert hängt vom Schlüssel ab", () => {
    expect(blocklistKeyCheck(key)).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(blocklistKeyCheck(key)).not.toBe(blocklistKeyCheck(other));
  });
});
