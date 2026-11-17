/**
 * Signatur und Verschlüsselung der Nutzdatei – NUR Schnittstelle, keine Umsetzung, keine Schlüssel im Code.
 *
 * Vorgaben laut GGT Anlage 16 „Security-Schnittstelle (SECON)“, Stand 02.09.2025, gültig ab 01.01.2026
 * (Kap. 1 und 2.1; Details in „Best Practice Security“):
 *  - Format PKCS#7/CMS: erst signieren (SignedData), dann verschlüsseln (EnvelopedData).
 *  - RSA mit mindestens 4096 Bit.
 *  - Signatur RSASSA-PSS (SHA-256, MGF1 mit SHA-256, Salt-Länge 32).
 *  - Schlüsseltransport RSAES-OAEP; Inhaltsverschlüsselung AES-256-CBC (id-aes256-CBC); Hash nur SHA-256.
 *  - Zertifikate X.509v3 vom ITSG Trust Center; Empfängerzertifikat = Datenannahmestelle mit
 *    Entschlüsselungsbefugnis laut Kostenträgerdatei (VKG Art 03); Bezug über Schlüsselliste bzw. LDAP.
 *  - Auftragsdatei: VERSCHLÜSSELUNGSART und ELEKTRONISCHE_UNTERSCHRIFT = "03" (PKCS#7), Dateigröße nach
 *    Verschlüsselung in DATEIGRÖSSE_ÜBERTRAGUNG.
 *
 * TODO (eigenes Paket, nicht in diesem PR):
 *  - Umsetzung (Kandidaten: secon-tool der TK als unveränderte LGPL-Bibliothek in einem Java-Sidecar, oder
 *    PKI.js/@peculiar mit Interop-Test gegen secon-tool). LGPL-Code wird nicht kopiert.
 *  - Schlüsselverwahrung (Modell (a) je Praxis vs. (b) Abrechnungsstelle/LE-Meldestelle), KMS/HSM,
 *    PKCS#10-Antrag, PKCS#7-Zertifikatsantwort, jährliche Folgeanträge (Zertifikate ab 2026: 1 Jahr Laufzeit).
 *  - Zertifikatskette und Sperrprüfung gegen die ITSG-Schlüsselliste; Post-Quanten-Fassung der Anlage 16
 *    (Entwurf angekündigt) beobachten.
 */

export interface ZertifikatsReferenz {
  /** IK, auf das das Zertifikat ausgestellt ist */
  ik: string;
  /** Fingerabdruck (SHA-256) zur Identifikation im Schlüsselspeicher – niemals der Schlüssel selbst */
  sha256Fingerabdruck?: string;
}

export interface SignierUndVerschluesselAuftrag {
  /** unverschlüsselte Nutzdatei (ISO 8859-1) */
  nutzdaten: Uint8Array;
  /** eigenes Zertifikat (Absender-Eigner); privater Schlüssel liegt ausschließlich im Kryptomodul */
  absender: ZertifikatsReferenz;
  /** Datenannahmestelle mit Entschlüsselungsbefugnis */
  empfaenger: ZertifikatsReferenz;
}

export interface Gkv302Kryptomodul {
  /** Liefert die CMS-Struktur (signiert und verschlüsselt) gemäß GGT Anlage 16. */
  signiereUndVerschluessele(auftrag: SignierUndVerschluesselAuftrag): Promise<Uint8Array>;
  /** Prüft eine eingehende Datei (z. B. Rückmeldung) und entschlüsselt sie. */
  entschluesseleUndPruefe?(daten: Uint8Array): Promise<{ nutzdaten: Uint8Array; absenderIk: string }>;
}

/** Platzhalter, damit Aufrufer früh scheitern statt unverschlüsselt zu versenden. */
export const KEIN_KRYPTOMODUL: Gkv302Kryptomodul = {
  async signiereUndVerschluessele() {
    throw new Error("SECON-Verschlüsselung (GGT Anlage 16) ist noch nicht umgesetzt – Versand nicht möglich.");
  },
};
