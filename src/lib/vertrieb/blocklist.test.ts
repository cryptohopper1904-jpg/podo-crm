import { describe, expect, it } from "vitest";
import { blocklistHash, hashedEmailSet } from "./blocklist";

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
