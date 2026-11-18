import { afterEach, describe, expect, it } from "vitest";
import { KEIN_KRYPTOMODUL, KRYPTO_FEHLT, aktivesKryptomodul, registriereKryptomodul, versandGruende, type Gkv302Kryptomodul } from "./sicherheit";

describe("Kryptovorbereitung (SECON-Schnittstelle)", () => {
  afterEach(() => registriereKryptomodul(null));

  it("ohne Modul: Status „nicht hinterlegt“, Versand scheitert früh, Gründe benannt", async () => {
    expect(aktivesKryptomodul()).toBe(KEIN_KRYPTOMODUL);
    const status = await KEIN_KRYPTOMODUL.status!({ ik: "990010013" });
    expect(status).toEqual({ zertifikat: "nicht_hinterlegt", ik: "990010013" });
    await expect(KEIN_KRYPTOMODUL.signiereUndVerschluessele({ nutzdaten: new Uint8Array(), absender: { ik: "990010013" }, empfaenger: { ik: "990030017" } })).rejects.toThrow(KRYPTO_FEHLT);
    expect(versandGruende(status)).toEqual([
      "Kein Kryptomodul (SECON, GGT Anlage 16) eingebunden.",
      "ITSG-Zertifikat der Praxis ist nicht hinterlegt.",
      "Schlüsselliste der Datenannahmestellen (annahme-*.key) ist nicht geladen.",
    ]);
  });

  it("ein künftiges Modul lässt sich einstecken; mit gültigem Zertifikat und Schlüsselliste keine Gründe mehr", () => {
    const attrappe: Gkv302Kryptomodul = { name: "Attrappe", signiereUndVerschluessele: async (a) => a.nutzdaten };
    registriereKryptomodul(attrappe);
    expect(aktivesKryptomodul()).toBe(attrappe);
    expect(versandGruende({ zertifikat: "gueltig", schluessellisteStand: "2026-11-18" })).toEqual([]);
    expect(versandGruende({ zertifikat: "abgelaufen", schluessellisteStand: "2026-11-18" })).toEqual(["ITSG-Zertifikat ist abgelaufen – Folgeantrag nötig."]);
  });
});
