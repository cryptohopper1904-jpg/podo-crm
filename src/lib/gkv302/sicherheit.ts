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

/**
 * Öffentliches Zertifikat (X.509v3, DER) einer Datenannahmestelle aus der Schlüsselliste des ITSG Trust Centers
 * (öffentliche Schlüsseldatei `annahme-*.key`, z. B. „annahme-rsa4096.key“; Base64-Zertifikate je IK). Nur öffentliche
 * Daten – die Liste darf im Klartext liegen, muss aber gegen die ITSG-Kette und das Gültigkeitsdatum geprüft werden.
 */
export interface AnnahmeZertifikat {
  ik: string;
  /** DER-kodiertes Zertifikat */
  der: Uint8Array;
  gueltigAb: string;
  gueltigBis: string;
  sha256Fingerabdruck: string;
}

/** Schlüsselliste der Datenannahmestellen (aus annahme-*.key), vom künftigen Kryptomodul geladen und geprüft */
export interface AnnahmeSchluesselliste {
  /** Stand der Liste (Download-Datum) */
  stand: string;
  /** gültiges Verschlüsselungszertifikat der Datenannahmestelle mit Entschlüsselungsbefugnis zum Stichtag */
  zertifikatFuer(ik: string, stichtag: string): AnnahmeZertifikat | null;
}

/**
 * Status des ITSG-Zertifikats der Praxis (bzw. der Abrechnungsstelle), wie ihn die Einstellungen anzeigen. In diesem
 * Paket gibt es nur „nicht_hinterlegt“; die übrigen Stufen beschreiben den Ablauf des späteren Kryptomoduls.
 */
export type ZertifikatsStatus =
  /** kein Antrag/kein Zertifikat in PodoHero */
  | "nicht_hinterlegt"
  /** PKCS#10-Antrag erzeugt und an das ITSG Trust Center geschickt, Zertifikat steht aus */
  | "beantragt"
  /** Zertifikat (PKCS#7-Antwort) eingespielt und zur Schlüsselliste passend */
  | "gueltig"
  /** Laufzeit endet in weniger als 60 Tagen (Folgeantrag nötig; Laufzeit seit 2026 ein Jahr) */
  | "laeuft_ab"
  | "abgelaufen";

export interface KryptoStatus {
  zertifikat: ZertifikatsStatus;
  /** IK, auf das das Zertifikat ausgestellt ist bzw. wird */
  ik?: string;
  gueltigBis?: string;
  /** Stand der Schlüsselliste der Datenannahmestellen, falls geladen */
  schluessellisteStand?: string;
}

export interface Gkv302Kryptomodul {
  /** Name für Anzeige/Protokoll, z. B. „secon-tool (Sidecar)“ */
  readonly name?: string;
  /** Zustand von Praxis-Zertifikat und Schlüsselliste – ohne private Daten */
  status?(organisation: { ik: string | null }): Promise<KryptoStatus>;
  /** Liefert die CMS-Struktur (signiert und verschlüsselt) gemäß GGT Anlage 16. */
  signiereUndVerschluessele(auftrag: SignierUndVerschluesselAuftrag): Promise<Uint8Array>;
  /** Prüft eine eingehende Datei (z. B. Rückmeldung) und entschlüsselt sie. */
  entschluesseleUndPruefe?(daten: Uint8Array): Promise<{ nutzdaten: Uint8Array; absenderIk: string }>;
}

export const KRYPTO_FEHLT = "SECON-Verschlüsselung (GGT Anlage 16) ist noch nicht umgesetzt – Versand nicht möglich.";

/** Platzhalter, damit Aufrufer früh scheitern statt unverschlüsselt zu versenden. */
export const KEIN_KRYPTOMODUL: Gkv302Kryptomodul = {
  name: "kein Kryptomodul",
  async status(o) {
    return { zertifikat: "nicht_hinterlegt", ik: o.ik ?? undefined };
  },
  async signiereUndVerschluessele() {
    throw new Error(KRYPTO_FEHLT);
  },
};

let aktiv: Gkv302Kryptomodul = KEIN_KRYPTOMODUL;

/**
 * Einsteckpunkt für das künftige Kryptomodul (z. B. beim Serverstart aus einem eigenen Paket registriert). Bis dahin
 * bleibt `KEIN_KRYPTOMODUL` aktiv; Tests können ein Attrappen-Modul setzen.
 */
export function registriereKryptomodul(modul: Gkv302Kryptomodul | null): void {
  aktiv = modul ?? KEIN_KRYPTOMODUL;
}

export function aktivesKryptomodul(): Gkv302Kryptomodul {
  return aktiv;
}

/**
 * Ob ein Versand überhaupt in Frage kommt (Echtdatei): nur mit gültigem Zertifikat und einem Modul, das signiert und
 * verschlüsselt. Liefert die Gründe, warum nicht – heute immer mindestens „Zertifikat nicht hinterlegt“.
 */
export function versandGruende(status: KryptoStatus, modul: Gkv302Kryptomodul = aktiv): string[] {
  const gruende: string[] = [];
  if (modul === KEIN_KRYPTOMODUL) gruende.push("Kein Kryptomodul (SECON, GGT Anlage 16) eingebunden.");
  if (status.zertifikat === "nicht_hinterlegt") gruende.push("ITSG-Zertifikat der Praxis ist nicht hinterlegt.");
  if (status.zertifikat === "beantragt") gruende.push("ITSG-Zertifikat ist beantragt, aber noch nicht eingespielt.");
  if (status.zertifikat === "abgelaufen") gruende.push("ITSG-Zertifikat ist abgelaufen – Folgeantrag nötig.");
  if (!status.schluessellisteStand) gruende.push("Schlüsselliste der Datenannahmestellen (annahme-*.key) ist nicht geladen.");
  return gruende;
}
