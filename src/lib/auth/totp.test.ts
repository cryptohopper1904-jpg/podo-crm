import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "./totp";

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Testvektor: Secret "12345678901234567890" (ASCII), T=59 → 94287082 (8 Stellen) → 6 Stellen: 287082
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("liefert den RFC-Testvektor", () => {
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(totpCode(secret, 1111111109_000)).toBe("081804");
  });
  it("base32 round-trip", () => {
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });
  it("akzeptiert ±1 Zeitfenster, lehnt Falsches ab", () => {
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, t - 30_000), t)).toBe(true);
    expect(verifyTotp(secret, "000000", t)).toBe(totpCode(secret, t) === "000000");
    expect(verifyTotp(secret, "abc", t)).toBe(false);
  });
});
