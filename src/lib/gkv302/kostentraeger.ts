/**
 * Kostenträgerdatei (KOTR) nach Anhang 3 zur TA1, Version 09 (ab 01.06.2026) und 10 (ab 01.02.2027),
 * Stand 07.10.2026. V09 und V10 unterscheiden sich nur in Schlüssel 8.14 (neue Haushaltshilfe-Codes C0–C4);
 * die Dateistruktur ist identisch, ein Parser genügt.
 *
 * Segmentfolge (Kap. 7, S. 12):
 *   [UNA] UNB { UNH IDK VDT FKT [KTO [VDT]] {VKG [VDT]} NAM [VDT] {ANS [VDT]} {ASP [VDT]} {UEM [VDT] {DFU [VDT]}} UNT } UNZ
 * Ermittlung der Annahmestellen (Kap. 5):
 *   IK der Versichertenkarte --VKG 01--> Kostenträger --VKG 03--> Datenannahmestelle mit Entschlüsselungsbefugnis
 *   (deren Nachricht ggf. --VKG 02--> Datenannahmestelle ohne Entschlüsselungsbefugnis = physikalischer Empfänger)
 *   Kostenträger --VKG 09--> Papierannahmestelle (Art der Datenlieferung 21/24/26/27 bzw. Gruppen 28/29).
 */
import type { DeepReadonly } from "./kotr-cache";
import { type EdifactGrenzen, maskiere, type RohSegment, vorpruefeEdifact, wert, zerlegeEdifact } from "./edifact";

export interface Gueltigkeit {
  /** "JJJJ-MM-TT" */
  ab: string;
  /** "JJJJ-MM-TT" oder undefined (offen) */
  bis?: string;
}

export interface KotrVerknuepfung {
  /** Schlüssel 8.3: 01 Kostenträger, 02 DAV ohne / 03 DAV mit Entschlüsselungsbefugnis, 09 Papierannahmestelle */
  art: string;
  ik: string;
  leistungserbringergruppe?: string;
  abrechnungsstelleIk?: string;
  /** Schlüssel 8.2 */
  artDerDatenlieferung?: string;
  /** Schlüssel 8.9 */
  uebermittlungsmedium?: string;
  /** Schlüssel 8.4 */
  bundesland?: string;
  /** Schlüssel 8.7 */
  kvBezirk?: string;
  /** Schlüssel 8.14 */
  abrechnungscode?: string;
  tarifkennzeichen?: string;
  /** Schlüssel 8.16 (HKP/HHH) */
  unterverfahren?: string;
  gueltigkeit?: Gueltigkeit;
}

export interface KotrAnschrift {
  /** Schlüssel 8.1: 1 Haus, 2 Postfach, 3 Großkunde */
  art: string;
  plz: string;
  ort: string;
  strasseOderPostfach?: string;
  gueltigkeit?: Gueltigkeit;
}

export interface KotrDfu {
  lfdNr: string;
  /** Schlüssel 8.5: 016 FTAM, 023 FTP, 070 E-Mail, 080 KIM */
  protokoll: string;
  benutzerkennung?: string;
  von?: string;
  bis?: string;
  uebertragungstage?: string;
  /** E-Mail-Adresse, KIM-Adresse, „VZD“ … */
  kommunikationskanal: string;
  gueltigkeit?: Gueltigkeit;
}

export interface KotrUebermittlung {
  /** Schlüssel 8.9 */
  medium: string;
  parameter: string;
  /** Schlüssel 8.11 */
  zeichensatz: string;
  komprimierung?: string;
  dfu: KotrDfu[];
  gueltigkeit?: Gueltigkeit;
}

export interface KotrInstitution {
  ik: string;
  artDerInstitution: string;
  kurzbezeichnung: string;
  vknr?: string;
  gueltigkeit: Gueltigkeit;
  /** Schlüssel 8.13: 01 Neuanmeldung, 02 Änderung, 03 Stornierung, 04 Unverändert */
  verarbeitungskennzeichen: string;
  konto?: { kontonummer?: string; blz?: string; bank: string; inhaber?: string; iban?: string; bic?: string; gueltigkeit?: Gueltigkeit };
  verknuepfungen: KotrVerknuepfung[];
  name: string[];
  /** VDT nach NAM (Anhang 3 V10 Kap. 7, S. 12: „+ NAM (+ VDT)“) */
  nameGueltigkeit?: Gueltigkeit;
  anschriften: KotrAnschrift[];
  ansprechpartner: { lfdNr: string; telefon?: string; fax?: string; name?: string; arbeitsgebiet?: string; gueltigkeit?: Gueltigkeit }[];
  uebermittlung: KotrUebermittlung[];
}

export interface Kostentraegerdatei {
  absenderIk: string;
  empfaengerIk: string;
  /** "JJMMTT:HHMM" wie in der Datei */
  erstellt: string;
  dateinummer: string;
  dateiname: string;
  institutionen: KotrInstitution[];
}

export class KotrFehler extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = "KotrFehler";
  }
}

function datum(jjjjmmtt: string, ort: string): string {
  if (!/^\d{8}$/.test(jjjjmmtt)) throw new KotrFehler(`${ort}: Datum „${jjjjmmtt}“ nicht im Format JJJJMMTT.`);
  return `${jjjjmmtt.slice(0, 4)}-${jjjjmmtt.slice(4, 6)}-${jjjjmmtt.slice(6, 8)}`;
}

function opt(s: string): string | undefined {
  return s === "" ? undefined : s;
}

function vdt(seg: RohSegment): Gueltigkeit {
  const ab = datum(wert(seg, 0), `Segment ${seg.nr} (VDT)`);
  const bisRoh = wert(seg, 1);
  return { ab, bis: bisRoh ? datum(bisRoh, `Segment ${seg.nr} (VDT)`) : undefined };
}

/** Dateiname nach Anhang 3 Kap. 6, z. B. "AO05Q426.KE2" */
export function pruefeKotrDateiname(name: string): { kassenart: string; gueltigAb: string; jahr: string; nachtrag: number } | null {
  const m = /^(AO|EK|BK|IK|BN|LK|GK|SB)05(0[1-9]|1[0-2]|Q[1-4])(\d{2})\.K([DEX])(\d)$/i.exec(name);
  if (!m) return null;
  return { kassenart: m[1].toUpperCase(), gueltigAb: m[2].toUpperCase(), jahr: m[3], nachtrag: Number(m[5]) };
}

/** Größte zulässige Kostenträgerdatei (Upload) in Byte; größte gemessene echte Datei: 214 KB (BN050526.KE0) */
export const KOTR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Obergrenzen vor dem Zerlegen (Review-Runden 2 und 3, AppSec H1). Ausgerichtet an sechs echten öffentlichen
 * Kostenträgerdateien (Stand Q4/2026, Messung docs/GKV-302.md 7.1): höchstens 6 471 Segmente, 12 Datenelemente und
 * 4 Gruppendatenelemente je Segment, 116 Zeichen je Segment, rund 63 000 Datenelemente gesamt. Die Grenzen lassen
 * reichlich Spielraum (Felder gut das Doppelte, Segmente gut das Zwölffache) und halten das Zerlegen auch im
 * ungünstigsten Fall (Elementtrenner „+“, Review-Runde 4) deutlich unter 100 MB Heap (Test „schlimmste noch zulässige
 * Eingabe“).
 */
export const KOTR_GRENZEN: EdifactGrenzen = { maxZeichen: KOTR_MAX_BYTES, maxSegmente: 80_000, maxElemente: 40, maxGruppen: 10, maxSegmentLaenge: 1_000, maxDatenelementeGesamt: 150_000 };

export interface KotrUmfang {
  maxInstitutionen: number;
  /** je Institution */
  maxVerknuepfungen: number;
  maxAnschriften: number;
  /** je Segmentart (VKG, ASP, UEM, DFU) über die ganze Datei */
  maxGesamt: number;
}
/** echte Höchstwerte: 365 Institutionen, 229 VKG je Institution, 6 183 VKG gesamt, 3 Anschriften je Institution */
export const KOTR_UMFANG: KotrUmfang = { maxInstitutionen: 10_000, maxVerknuepfungen: 2_000, maxAnschriften: 50, maxGesamt: 50_000 };

/** Inhaltliche Grenzen nach dem Zerlegen (Institutionen, Verknüpfungen/Anschriften je Institution, Gesamtzahlen) */
export function pruefeKotrUmfang(d: Kostentraegerdatei, g: KotrUmfang = KOTR_UMFANG): void {
  if (d.institutionen.length > g.maxInstitutionen) throw new KotrFehler(`Die Kostenträgerdatei hat zu viele Institutionen (${d.institutionen.length}, höchstens ${g.maxInstitutionen}).`);
  const gesamt = { vkg: 0, asp: 0, uem: 0, dfu: 0 };
  for (const i of d.institutionen) {
    if (i.verknuepfungen.length > g.maxVerknuepfungen) throw new KotrFehler(`IK ${i.ik}: zu viele Verknüpfungen (${i.verknuepfungen.length}, höchstens ${g.maxVerknuepfungen}).`);
    if (i.anschriften.length > g.maxAnschriften) throw new KotrFehler(`IK ${i.ik}: zu viele Anschriften (${i.anschriften.length}, höchstens ${g.maxAnschriften}).`);
    gesamt.vkg += i.verknuepfungen.length;
    gesamt.asp += i.ansprechpartner.length;
    gesamt.uem += i.uebermittlung.length;
    for (const u of i.uebermittlung) gesamt.dfu += u.dfu.length;
  }
  const namen: Record<keyof typeof gesamt, string> = { vkg: "Verknüpfungen", asp: "Ansprechpartner", uem: "Übermittlungsangaben", dfu: "DFÜ-Angaben" };
  for (const k of Object.keys(gesamt) as (keyof typeof gesamt)[]) {
    if (gesamt[k] > g.maxGesamt) throw new KotrFehler(`Die Kostenträgerdatei hat zu viele ${namen[k]} insgesamt (${gesamt[k]}, höchstens ${g.maxGesamt}).`);
  }
}

/**
 * Parst eine Kostenträgerdatei (Text, bereits aus ISO 8859-1 dekodiert). Vorher Vorprüfung gegen `grenzen`, damit
 * präparierte Dateien nicht beim Zerlegen den Speicher füllen.
 */
export function parseKostentraegerdatei(inhalt: string, grenzen: EdifactGrenzen = KOTR_GRENZEN): Kostentraegerdatei {
  try {
    vorpruefeEdifact(inhalt, grenzen);
  } catch (e) {
    throw new KotrFehler((e as Error).message);
  }
  const segmente = zerlegeEdifact(inhalt);
  if (segmente[0]?.kennung !== "UNB") throw new KotrFehler("Kostenträgerdatei beginnt nicht mit UNB.");
  const unb = segmente[0];
  if (wert(unb, 0, 0) !== "UNOC") throw new KotrFehler(`Unerwartete Syntax „${wert(unb, 0, 0)}“ (erwartet UNOC).`);
  const unz = segmente[segmente.length - 1];
  if (unz?.kennung !== "UNZ") throw new KotrFehler("Kostenträgerdatei endet nicht mit UNZ.");

  const datei: Kostentraegerdatei = {
    absenderIk: wert(unb, 1),
    empfaengerIk: wert(unb, 2),
    erstellt: `${wert(unb, 3, 0)}:${wert(unb, 3, 1)}`,
    dateinummer: wert(unb, 4),
    // UNB laut Anhang 3: … Dateinummer, Freifeld, Dateiname
    dateiname: wert(unb, 6),
    institutionen: [],
  };
  if (wert(unz, 1) !== datei.dateinummer) throw new KotrFehler("UNZ-Dateinummer stimmt nicht mit UNB überein.");

  let aktuell: KotrInstitution | null = null;
  let segInNachricht = 0;
  let nachrichten = 0;
  /** Ziel für ein folgendes VDT-Segment */
  let vdtZiel: { gueltigkeit?: Gueltigkeit } | null = null;
  let ref = "";

  for (const seg of segmente.slice(1, -1)) {
    const ort = `Segment ${seg.nr} (${seg.kennung})`;
    if (seg.kennung === "UNH") {
      if (aktuell) throw new KotrFehler(`${ort}: UNH ohne vorheriges UNT.`);
      if (wert(seg, 1, 0) !== "KOTR") throw new KotrFehler(`${ort}: Nachrichtentyp „${wert(seg, 1, 0)}“ statt KOTR.`);
      nachrichten++;
      ref = wert(seg, 0);
      segInNachricht = 1;
      aktuell = { ik: "", artDerInstitution: "", kurzbezeichnung: "", gueltigkeit: { ab: "" }, verarbeitungskennzeichen: "", verknuepfungen: [], name: [], anschriften: [], ansprechpartner: [], uebermittlung: [] };
      vdtZiel = null;
      continue;
    }
    if (!aktuell) throw new KotrFehler(`${ort}: Segment außerhalb einer Nachricht.`);
    segInNachricht++;
    switch (seg.kennung) {
      case "IDK": {
        const ik = wert(seg, 0);
        if (!/^\d{9}$/.test(ik)) throw new KotrFehler(`${ort}: IK „${ik}“ ist nicht 9-stellig numerisch.`);
        aktuell.ik = ik;
        aktuell.artDerInstitution = wert(seg, 1);
        aktuell.kurzbezeichnung = wert(seg, 2);
        aktuell.vknr = opt(wert(seg, 3));
        vdtZiel = aktuell;
        break;
      }
      case "VDT": {
        if (!vdtZiel) throw new KotrFehler(`${ort}: VDT ohne zugehöriges Segment.`);
        vdtZiel.gueltigkeit = vdt(seg);
        vdtZiel = null;
        break;
      }
      case "FKT":
        aktuell.verarbeitungskennzeichen = wert(seg, 0);
        vdtZiel = null;
        break;
      case "KTO":
        aktuell.konto = { kontonummer: opt(wert(seg, 0)), blz: opt(wert(seg, 1)), bank: wert(seg, 2), inhaber: opt(wert(seg, 3)), iban: opt(wert(seg, 4)), bic: opt(wert(seg, 5)) };
        vdtZiel = aktuell.konto;
        break;
      case "VKG": {
        const v: KotrVerknuepfung = {
          art: wert(seg, 0),
          ik: wert(seg, 1),
          leistungserbringergruppe: opt(wert(seg, 2)),
          abrechnungsstelleIk: opt(wert(seg, 3)),
          artDerDatenlieferung: opt(wert(seg, 4)),
          uebermittlungsmedium: opt(wert(seg, 5)),
          bundesland: opt(wert(seg, 6)),
          kvBezirk: opt(wert(seg, 7)),
          abrechnungscode: opt(wert(seg, 8)),
          tarifkennzeichen: opt(wert(seg, 9)),
          unterverfahren: opt(wert(seg, 10)),
        };
        if (!/^\d{9}$/.test(v.ik)) throw new KotrFehler(`${ort}: IK des Verknüpfungspartners „${v.ik}“ ist nicht 9-stellig.`);
        aktuell.verknuepfungen.push(v);
        vdtZiel = v;
        break;
      }
      case "NAM": {
        aktuell.name = seg.elemente.slice(1).map((e) => e[0] ?? "").filter((s) => s !== "");
        // Segmentfolge Anhang 3 V10 Kap. 7, S. 12: „+ NAM (+ VDT)“ – ein folgendes VDT gilt für den Namen
        const inst = aktuell;
        vdtZiel = {
          set gueltigkeit(g: Gueltigkeit | undefined) {
            inst.nameGueltigkeit = g;
          },
        };
        break;
      }
      case "ANS": {
        const a: KotrAnschrift = { art: wert(seg, 0), plz: wert(seg, 1), ort: wert(seg, 2), strasseOderPostfach: opt(wert(seg, 3)) };
        aktuell.anschriften.push(a);
        vdtZiel = a;
        break;
      }
      case "ASP": {
        const a = { lfdNr: wert(seg, 0), telefon: opt(wert(seg, 1)), fax: opt(wert(seg, 2)), name: opt(wert(seg, 3)), arbeitsgebiet: opt(wert(seg, 4)) } as KotrInstitution["ansprechpartner"][number];
        aktuell.ansprechpartner.push(a);
        vdtZiel = a;
        break;
      }
      case "UEM": {
        const u: KotrUebermittlung = { medium: wert(seg, 0), parameter: wert(seg, 1), zeichensatz: wert(seg, 2), komprimierung: opt(wert(seg, 3)), dfu: [] };
        aktuell.uebermittlung.push(u);
        vdtZiel = u;
        break;
      }
      case "DFU": {
        const u = aktuell.uebermittlung[aktuell.uebermittlung.length - 1];
        if (!u) throw new KotrFehler(`${ort}: DFU ohne vorheriges UEM.`);
        const d: KotrDfu = { lfdNr: wert(seg, 0), protokoll: wert(seg, 1), benutzerkennung: opt(wert(seg, 2)), von: opt(wert(seg, 3)), bis: opt(wert(seg, 4)), uebertragungstage: opt(wert(seg, 5)), kommunikationskanal: wert(seg, 6) };
        u.dfu.push(d);
        vdtZiel = d;
        break;
      }
      case "UNT": {
        if (wert(seg, 1) !== ref) throw new KotrFehler(`${ort}: Nachrichtenreferenz „${wert(seg, 1)}“ passt nicht zu UNH „${ref}“.`);
        if (Number(wert(seg, 0)) !== segInNachricht) throw new KotrFehler(`${ort}: UNT nennt ${Number(wert(seg, 0))} Segmente, gezählt wurden ${segInNachricht}.`);
        if (!aktuell.ik) throw new KotrFehler(`${ort}: Nachricht ohne IDK.`);
        if (!aktuell.gueltigkeit.ab) throw new KotrFehler(`${ort}: IDK ohne VDT (Gültigkeit) für IK ${aktuell.ik}.`);
        datei.institutionen.push(aktuell);
        aktuell = null;
        vdtZiel = null;
        break;
      }
      default:
        // unbekannte Segmente werden ignoriert (aufwärtskompatibel)
        vdtZiel = null;
    }
  }
  if (aktuell) throw new KotrFehler("Letzte Nachricht ohne UNT.");
  if (Number(wert(unz, 0)) !== nachrichten) throw new KotrFehler(`UNZ nennt ${Number(wert(unz, 0))} Nachrichten, enthalten sind ${nachrichten}.`);
  return datei;
}

// ───────────────────────── Ermittlung der Annahmestellen ─────────────────────────

function gilt(g: Gueltigkeit | undefined, stichtag: string): boolean {
  if (!g) return true;
  return g.ab <= stichtag && (g.bis === undefined || stichtag <= g.bis);
}

/** Gruppenschlüssel aus Anlage 3 Kap. 8.14 und die Einzelschlüssel, die sie umfassen */
const GRUPPEN: Record<string, (ac: string) => boolean> = {
  "10": (ac) => /^1[1-9]$/.test(ac),
  "20": (ac) => /^2[1-9]$/.test(ac),
  "30": (ac) => /^3[1-4]$/.test(ac),
  "40": (ac) => /^4[1-9]$/.test(ac),
  "90": (ac) => /^9[1-4]$/.test(ac),
  A0: (ac) => /^A[1-8]$/.test(ac),
  C0: (ac) => /^C[1-4]$/.test(ac),
};

/** Rang der Übereinstimmung: 3 Einzelschlüssel, 2 Gruppenschlüssel, 1 Sonderschlüssel 99, 0 Sammelschlüssel 00 / ohne Angabe, -1 passt nicht */
function rangAbrechnungscode(vkgCode: string | undefined, ac: string): number {
  if (vkgCode === undefined || vkgCode === "00") return 0;
  if (vkgCode === ac) return 3;
  if (GRUPPEN[vkgCode]?.(ac)) return 2;
  if (vkgCode === "99") return 1;
  return -1;
}

export interface Annahmestelle {
  ik: string;
  name: string;
  anschriften: KotrAnschrift[];
}

export interface DatenannahmeErgebnis {
  /** IK von der Versichertenkarte (Eingabe) */
  kasseIk: string;
  /** FKT IK des Kostenträgers */
  kostentraeger: Annahmestelle;
  /** Datenannahmestelle mit Entschlüsselungsbefugnis: UNB-Empfänger, Auftragsdatei EMPFÄNGER_NUTZER, Verschlüsselungszertifikat */
  datenannahmestelle: Annahmestelle;
  /** physikalischer Empfänger (DAV ohne Entschlüsselungsbefugnis, sonst = Datenannahmestelle): Auftragsdatei EMPFÄNGER_PHYSIKALISCH */
  physikalischerEmpfaenger: Annahmestelle;
  /** DFÜ-Wege des physikalischen Empfängers, z. B. E-Mail (070) oder KIM (080) */
  uebertragungswege: { protokoll: string; kanal: string }[];
  /** Papierannahmestellen für Verordnungen/Rechnung/Kostenvoranschlag */
  belegannahmestellen: (Annahmestelle & { artDerDatenlieferung?: string })[];
  hinweise: string[];
}

export interface Suchkriterien {
  kasseIk: string;
  /** Stichtag "JJJJ-MM-TT" (z. B. Versanddatum) */
  stichtag: string;
  /** Abrechnungscode des Leistungserbringers, Podologie "71" */
  abrechnungscode: string;
  tarifkennzeichen?: string;
  /** Standort des Leistungserbringers, Schlüssel 8.4 (z. B. "11" Berlin) */
  bundesland?: string;
  /** IK der Abrechnungsstelle, falls über eine solche abgerechnet wird */
  abrechnungsstelleIk?: string;
}

/** Index aller zum Stichtag gültigen Nachrichten je IK */
export class KostentraegerVerzeichnis {
  private readonly nachIk = new Map<string, KotrInstitution[]>();

  /**
   * Nimmt auch schreibgeschützte (eingefrorene) Dateien aus dem Cache (src/lib/gkv302/kotr-cache.ts). Das Verzeichnis
   * liest nur und verändert nichts; die Typumwandlung unten ist deshalb unbedenklich.
   */
  constructor(dateien: readonly (Kostentraegerdatei | DeepReadonly<Kostentraegerdatei>)[]) {
    for (const d of dateien as readonly Kostentraegerdatei[]) {
      for (const inst of d.institutionen) {
        const liste = this.nachIk.get(inst.ik) ?? [];
        liste.push(inst);
        this.nachIk.set(inst.ik, liste);
      }
    }
  }

  institution(ik: string, stichtag: string): KotrInstitution | undefined {
    return (this.nachIk.get(ik) ?? []).find((i) => i.verarbeitungskennzeichen !== "03" && gilt(i.gueltigkeit, stichtag));
  }

  private stelle(ik: string, stichtag: string): Annahmestelle {
    const i = this.institution(ik, stichtag);
    if (!i) throw new KotrFehler(`IK ${ik} ist in der Kostenträgerdatei zum ${stichtag} nicht (gültig) enthalten.`);
    return { ik, name: i.name.join(" ") || i.kurzbezeichnung, anschriften: i.anschriften.filter((a) => gilt(a.gueltigkeit, stichtag)) };
  }

  /** Verknüpfungen einer Art, die für die Kriterien gelten, nach bestem Abrechnungscode-Rang */
  private passende(inst: KotrInstitution, art: string, k: Suchkriterien, hinweise: string[], lieferarten?: string[]): KotrVerknuepfung[] {
    const kandidaten = inst.verknuepfungen.filter(
      (v) =>
        v.art === art &&
        gilt(v.gueltigkeit, k.stichtag) &&
        (v.leistungserbringergruppe === undefined || v.leistungserbringergruppe === "5") &&
        (v.abrechnungsstelleIk === undefined || v.abrechnungsstelleIk === k.abrechnungsstelleIk) &&
        (v.tarifkennzeichen === undefined || k.tarifkennzeichen === undefined || v.tarifkennzeichen === k.tarifkennzeichen) &&
        // Anhang 3 V10 Kap. 5.2, S. 9: Verweis 02/03 „nur gültig in Verbindung mit dem Schlüssel 07 oder 30 bei Art
        // der Datenlieferung“ – ohne Angabe also nicht gültig
        (lieferarten === undefined || (v.artDerDatenlieferung !== undefined && lieferarten.includes(v.artDerDatenlieferung))) &&
        rangAbrechnungscode(v.abrechnungscode, k.abrechnungscode) >= 0,
    );
    if (!kandidaten.length) return [];
    // reduce statt Math.max(...): kein Argument je Verknüpfung auf dem Aufrufstapel (Review-Runde 2, AppSec H2)
    const besterRang = kandidaten.reduce((m, v) => Math.max(m, rangAbrechnungscode(v.abrechnungscode, k.abrechnungscode)), -1);
    let beste = kandidaten.filter((v) => rangAbrechnungscode(v.abrechnungscode, k.abrechnungscode) === besterRang);
    // regionale Zuordnung (Kap. 5.2.2)
    const regional = beste.filter((v) => v.bundesland !== undefined && v.bundesland !== "99");
    if (regional.length) {
      if (k.bundesland) {
        const treffer = beste.filter((v) => v.bundesland === k.bundesland || v.bundesland === "99" || v.bundesland === undefined);
        const genau = treffer.filter((v) => v.bundesland === k.bundesland);
        beste = genau.length ? genau : treffer;
      } else {
        const iks = new Set(beste.map((v) => v.ik));
        if (iks.size > 1) hinweise.push(`IK ${inst.ik}: mehrere regionale Verknüpfungen (Art ${art}); bitte Standort (Bundesland) angeben.`);
      }
    }
    return beste;
  }

  /**
   * Ermittelt zu einer Kassen-IK (KV-Karte/Verordnung) Kostenträger, Datenannahmestelle(n) und Belegannahmestellen.
   * Wirft KotrFehler mit deutscher Meldung, wenn die Kette nicht vollständig auflösbar ist.
   */
  ermittle(k: Suchkriterien): DatenannahmeErgebnis {
    const hinweise: string[] = [];
    const karte = this.institution(k.kasseIk, k.stichtag);
    if (!karte) throw new KotrFehler(`IK ${k.kasseIk} der Krankenkasse ist in der Kostenträgerdatei zum ${k.stichtag} nicht enthalten.`);
    // 5.1 Verweis IK der Versichertenkarte → Kostenträger (VKG 01); fehlt er, ist das IK selbst der Kostenträger
    const zumKt = karte.verknuepfungen.filter((v) => v.art === "01" && gilt(v.gueltigkeit, k.stichtag));
    const ktIk = zumKt[0]?.ik ?? karte.ik;
    if (zumKt.length > 1 && new Set(zumKt.map((v) => v.ik)).size > 1) hinweise.push(`IK ${k.kasseIk}: mehrere Kostenträger-Verweise, der erste wurde verwendet.`);
    const kt = ktIk === karte.ik ? karte : this.institution(ktIk, k.stichtag);
    if (!kt) throw new KotrFehler(`Kostenträger ${ktIk} (Verweis von ${k.kasseIk}) ist zum ${k.stichtag} nicht enthalten.`);

    // 5.2 Datenannahmestellen; Verweis nur gültig mit Art der Datenlieferung 07 oder 30
    const mitEntschl = this.passende(kt, "03", k, hinweise, ["07", "30"]);
    if (!mitEntschl.length) {
      throw new KotrFehler(`Für Kostenträger ${ktIk} gibt es zum ${k.stichtag} keine Datenannahmestelle mit Entschlüsselungsbefugnis für Abrechnungscode ${k.abrechnungscode}.`);
    }
    const davIk = mitEntschl[0].ik;
    const davIks = [...new Set(mitEntschl.map((v) => v.ik))];
    if (davIks.length > 1) hinweise.push(`Für Kostenträger ${ktIk} sind mehrere Datenannahmestellen mit Entschlüsselungsbefugnis gleichwertig (${davIks.join(", ")}); verwendet wurde ${davIk}. Bitte Standort (Bundesland) oder Tarifkennzeichen angeben.`);
    const dav = this.institution(davIk, k.stichtag);
    if (!dav) throw new KotrFehler(`Datenannahmestelle ${davIk} ist zum ${k.stichtag} nicht in der Kostenträgerdatei enthalten.`);
    // DAV ohne Entschlüsselungsbefugnis: zuerst am Kostenträger, sonst in der Nachricht der DAV (Kap. 5.2.1)
    const ohneEntschl = this.passende(kt, "02", k, hinweise, ["07", "30"]);
    const weiterleitung = ohneEntschl.length ? ohneEntschl : this.passende(dav, "02", k, hinweise, ["07", "30"]);
    const physIk = weiterleitung[0]?.ik ?? davIk;
    const phys = this.institution(physIk, k.stichtag);
    if (!phys) throw new KotrFehler(`Physikalischer Empfänger ${physIk} ist zum ${k.stichtag} nicht in der Kostenträgerdatei enthalten.`);
    const wege = phys.uebermittlung
      .filter((u) => u.medium === "1" && gilt(u.gueltigkeit, k.stichtag))
      .flatMap((u) => u.dfu.filter((d) => gilt(d.gueltigkeit, k.stichtag)).map((d) => ({ protokoll: d.protokoll, kanal: d.kommunikationskanal })));
    if (!wege.length) hinweise.push(`Für ${physIk} ist kein DFÜ-Weg (UEM/DFU) hinterlegt.`);

    // 5.3 Papierannahmestellen (VKG 09)
    const papier = this.passende(kt, "09", k, hinweise);
    const belegannahmestellen = papier.map((v) => ({ ...this.stelle(v.ik, k.stichtag), artDerDatenlieferung: v.artDerDatenlieferung }));
    if (!belegannahmestellen.length) hinweise.push(`Für Kostenträger ${ktIk} ist keine Papierannahmestelle angegeben; sie wird ggf. auf anderem Weg bekannt gegeben (Anhang 3 Kap. 5.3).`);

    return {
      kasseIk: k.kasseIk,
      kostentraeger: this.stelle(ktIk, k.stichtag),
      datenannahmestelle: this.stelle(davIk, k.stichtag),
      physikalischerEmpfaenger: this.stelle(physIk, k.stichtag),
      uebertragungswege: wege,
      belegannahmestellen,
      hinweise,
    };
  }
}

// ───────────────────────── Schreiben (für Testdateien und Roundtrip) ─────────────────────────

function seg(kennung: string, ...elemente: (string | undefined)[]): string {
  const teile = [kennung, ...elemente.map((e) => (e === undefined ? "" : maskiere(e)))];
  while (teile.length > 1 && teile[teile.length - 1] === "") teile.pop();
  return teile.join("+") + "'";
}

function vdtSeg(g: Gueltigkeit | undefined): string[] {
  return g ? [seg("VDT", g.ab.replace(/-/g, ""), g.bis?.replace(/-/g, ""))] : [];
}

/** Schreibt ein Modell wieder als Kostenträgerdatei (ohne UNA, ein Segment je Zeile). */
export function schreibeKostentraegerdatei(d: Kostentraegerdatei): string {
  const zeilen: string[] = [];
  const [datum, zeit] = d.erstellt.split(":");
  zeilen.push(`UNB+UNOC:3+${d.absenderIk}+${d.empfaengerIk}+${datum}:${zeit}+${d.dateinummer}++${maskiere(d.dateiname)}'`);
  d.institutionen.forEach((i, n) => {
    const ref = String(n + 1).padStart(5, "0");
    const s: string[] = [`UNH+${ref}+KOTR:02:001:KV'`, seg("IDK", i.ik, i.artDerInstitution, i.kurzbezeichnung, i.vknr), ...vdtSeg(i.gueltigkeit), seg("FKT", i.verarbeitungskennzeichen)];
    if (i.konto) s.push(seg("KTO", i.konto.kontonummer, i.konto.blz, i.konto.bank, i.konto.inhaber, i.konto.iban, i.konto.bic), ...vdtSeg(i.konto.gueltigkeit));
    for (const v of i.verknuepfungen) {
      s.push(seg("VKG", v.art, v.ik, v.leistungserbringergruppe, v.abrechnungsstelleIk, v.artDerDatenlieferung, v.uebermittlungsmedium, v.bundesland, v.kvBezirk, v.abrechnungscode, v.tarifkennzeichen, v.unterverfahren), ...vdtSeg(v.gueltigkeit));
    }
    s.push(seg("NAM", "01", ...i.name), ...vdtSeg(i.nameGueltigkeit));
    for (const a of i.anschriften) s.push(seg("ANS", a.art, a.plz, a.ort, a.strasseOderPostfach), ...vdtSeg(a.gueltigkeit));
    for (const a of i.ansprechpartner) s.push(seg("ASP", a.lfdNr, a.telefon, a.fax, a.name, a.arbeitsgebiet), ...vdtSeg(a.gueltigkeit));
    for (const u of i.uebermittlung) {
      s.push(seg("UEM", u.medium, u.parameter, u.zeichensatz, u.komprimierung), ...vdtSeg(u.gueltigkeit));
      for (const f of u.dfu) s.push(seg("DFU", f.lfdNr, f.protokoll, f.benutzerkennung, f.von, f.bis, f.uebertragungstage, f.kommunikationskanal), ...vdtSeg(f.gueltigkeit));
    }
    s.push(`UNT+${String(s.length + 1).padStart(6, "0")}+${ref}'`);
    zeilen.push(...s);
  });
  zeilen.push(`UNZ+${String(d.institutionen.length).padStart(6, "0")}+${d.dateinummer}'`);
  return zeilen.join("\r\n") + "\r\n";
}
