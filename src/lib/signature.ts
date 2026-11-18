/**
 * Unterschrift der versicherten Person je Behandlung (GKV-Leistungsnachweis, Vertrag § 125 SGB V Podologie, Anlage 3
 * Buchst. o) – gemeinsame Konstanten und reine Prüfungen (Server und Browser).
 */

export const SIGNER_ROLES = ["insured", "caregiver", "relative"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export const SIGNER_ROLE_LABEL: Record<SignerRole, string> = {
  insured: "Versicherte:r",
  caregiver: "Betreuungsperson",
  relative: "Angehörige:r",
};

/** Größenlimit der PNG-Datei (DB-CHECK in Migration 0064 identisch) */
export const MAX_SIGNATURE_BYTES = 200_000;
/** data:-URL (Base64, +33 %) inkl. Präfix */
export const MAX_SIGNATURE_DATAURL_CHARS = Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 64;
/** Abmessungen der Zeichenfläche in Pixeln (feste Auflösung, unabhängig vom Gerät) */
export const SIGNATURE_WIDTH = 900;
export const SIGNATURE_HEIGHT = 300;
const MAX_DIMENSION = 2000;

export const PAPER_SIGNATURE_LABEL = "Unterschrift auf der Papier-Verordnung (Rückseite) erfasst";
export const SIGNATURE_MISSING = "Unterschrift fehlt";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Prüft eine PNG-Datei (Signatur, IHDR, Abmessungen, Größe). Die Bytes stammen aus dem Browser und sind nicht
 * vertrauenswürdig – geprüft wird der echte Inhalt, nicht der angegebene Typ.
 */
export function checkSignaturePng(bytes: Uint8Array): { ok: true; width: number; height: number } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "Unterschrift fehlt." };
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, error: "Die Unterschrift ist zu groß – bitte löschen und erneut unterschreiben." };
  if (bytes.length < 33 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) return { ok: false, error: "Die Unterschrift ist kein gültiges Bild (PNG)." };
  // erster Chunk muss IHDR mit Länge 13 sein
  const len = (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11];
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (len !== 13 || type !== "IHDR") return { ok: false, error: "Die Unterschrift ist kein gültiges Bild (PNG)." };
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  if (width < 50 || height < 20 || width > MAX_DIMENSION || height > MAX_DIMENSION) return { ok: false, error: "Die Unterschrift hat ungültige Abmessungen." };
  return { ok: true, width, height };
}
