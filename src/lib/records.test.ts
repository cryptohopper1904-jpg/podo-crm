import { describe, expect, it } from "vitest";
import { chainHash, verifyChain } from "./records";

describe("Hash-Kette", () => {
  it("erkennt Manipulation", () => {
    const a = { findings: "Hyperkeratose Ferse li" };
    const b = { findings: "Kontrolle, unauffällig" };
    const h1 = chainHash(null, a);
    const h2 = chainHash(h1, b);
    const chain = [
      { prevHash: null, hash: h1, content: a },
      { prevHash: h1, hash: h2, content: b },
    ];
    expect(verifyChain(chain)).toBe(-1);
    chain[0].content = { findings: "geändert" };
    expect(verifyChain(chain)).toBe(0);
  });
  it("ist unabhängig von der Schlüsselreihenfolge", () => {
    expect(chainHash(null, { a: 1, b: 2 })).toBe(chainHash(null, { b: 2, a: 1 }));
  });
});
