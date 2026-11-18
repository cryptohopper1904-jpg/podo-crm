/**
 * Direktabrechnung § 302 SGB V in PodoHero (Paket D, Erprobung): Prüflauf und Testpaket.
 *
 * Reine Funktionen ohne DB und ohne Dateiablage. Der Server-Teil (src/server/gkv302-export.ts) lädt Praxis,
 * Verordnungen, Preis-Snapshots, Befreiungen und Kostenträgerdateien (mandantengetrennt) und ruft dann:
 *  1. `pruefeFaelle` – je Verordnung `bildeAbrechnungsfall` (Adapter) + Kostenträger/Datenannahmestelle aus der
 *     Kostenträgerdatei + TA1-Prüfung als Einzelfall. Ergebnis: ok / fehlende Angaben / Abweichungen / Hinweise.
 *  2. `erzeugeTestpaket` – NUR die Fälle mit Status „ok“, gruppiert je Datenannahmestelle mit Entschlüsselungsbefugnis
 *     und Kassenart (TA1 Kap. 3 Abs. 1), Dateiart „test“ (Testindikator 0, physikalischer Name `TSOL0…`, Anhang 2
 *     Kap. 5). Nichts wird verschlüsselt oder signiert (`sicherheit.ts`): die Dateien sind ausdrücklich nicht für den
 *     Versand an eine Datenannahmestelle bestimmt.
 *
 * Fälle mit fehlenden Angaben oder Abweichungen werden hier – nicht erst in `pruefeNutzdatendatei` – ausgeschlossen:
 * `erzeugeTestpaket` nimmt ausschließlich Fälle mit `status === "ok"` und bricht ab, wenn keiner übrig ist.
 */
import { bildeAbrechnungsfall, type ErgaenzendeVerordnungsdaten, type PodoHeroPatient, type PodoHeroVerordnung, type PreisSnapshot } from "./adapter";
import { erzeugeAuftragsdatei } from "./auftragsdatei";
import { fallBetraege } from "./betraege";
import { erstelleBegleitzettel, type Begleitzettel } from "./begleitzettel";
import { physikalischerDateiname } from "./dateiname";
import { Gkv302ValidierungsFehler } from "./fehler";
import { istGueltigesIk } from "./ik";
import type { DeepReadonly } from "./kotr-cache";
import { KostentraegerVerzeichnis, KotrFehler, pruefeKotrDateiname, type Kostentraegerdatei } from "./kostentraeger";
import { erzeugeNutzdatendatei, pruefeNutzdatendatei, ZUZAHLUNG_PAUSCHALE_CENT, type NutzdateiErgebnis } from "./nutzdatei";
import { VERORDNUNGSBESONDERHEIT, istGueltigesTarifkennzeichen, type Verordnungsart } from "./schluessel";
import type { Abrechnungsfall, Gesamtrechnung, KostentraegerAbrechnung, Nutzdatendatei, Praxis, TaVersion } from "./typen";

/** Zuzahlungsprozentsatz (§ 61 Satz 3 SGB V) – wie im Preis-Snapshot (#111) */
export const ZUZAHLUNG_PROZENT = 10;
/** Obergrenze je Prüflauf/Testpaket (Speicher, Dateigröße) */
export const MAX_FAELLE_JE_LAUF = 1000;

/** Leistungserbringergruppe → Abrechnungscode (Anlage 3 8.1.5.1): nur Podolog:innen 71 und Med. Fußpfleger:innen 72 */
const ABRECHNUNGSCODE_AUS_LEGS: Record<string, "71" | "72"> = { "7100501": "71", "7200501": "72" };

// ───────────────────────── Eingaben ─────────────────────────

/** Praxis-Stammdaten aus `organizations` (+ `settings.gkv302`) */
export interface DaPraxis {
  ik: string | null;
  name: string;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  telefon: string | null;
  email: string | null;
  /** Leistungserbringergruppe (LEGS, z. B. 7100501) */
  legsCode: string | null;
  /** Tarifkennzeichen laut Zulassung/Vertrag (5 Stellen, Anlage 3 8.1.5.2) */
  tarifkennzeichen: string | null;
  /** Schlüssel 8.4 Bundesland für die regionale Zuordnung in der Kostenträgerdatei (optional) */
  kotrBundesland?: string | null;
}

/** Eine Verordnung mit Patientendaten, wie sie aus der DB kommt (nur die benötigten Felder) */
export interface DaVerordnung {
  id: string;
  /** nur zur Anzeige im Prüflauf (Name + Nummer); geht nicht in Logs */
  anzeige: string;
  issuedAt: string;
  doctorLanr: string | null;
  doctorBsnr: string | null;
  diagnosisGroup: string;
  icd10: string | null;
  diagnosisText: string | null;
  leitsymptomatik: string | null;
  leitsymptomatikText: string | null;
  homeVisit: boolean;
  urgent: boolean;
  copaymentExempt: boolean;
  therapyReportRequested: boolean;
  externalRef: string | null;
  source: string;
  insurerIk: string | null;
  insuranceNumber: string | null;
  insuredStatus: string | null;
  /** gespeicherter Preis-Snapshot (JSON aus der DB, unverändert) */
  priceSnapshot: unknown;
  /**
   * Kennzeichen Verordnungsart (Anlage 3 8.1.12) – seit GKV Paket C an der Verordnung bestätigt
   * (`prescriptions.prescription_kind`); nicht bestätigt (`null`) → fehlende Angabe. Nie raten oder vorbelegen.
   */
  verordnungsart?: Verordnungsart | null;
  /** Kennzeichen Verordnungsbesonderheiten (Anlage 3 8.1.11), `null` = keine */
  verordnungsbesonderheit?: string | null;
  /** Genehmigung eines langfristigen Heilmittelbedarfs (SKZ, Art B2): Kennzeichen und Datum */
  genehmigung?: { kennzeichen: string; datum: string } | null;
  patient: {
    lastName: string;
    firstName: string | null;
    birthDate: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
    insuranceNumber: string | null;
    insurerIk: string | null;
    insuredStatus: string | null;
    copaymentExemptions: unknown;
  };
}

/** Kostenträgerdatei mit Kassenart (aus dem Dateinamen, Anhang 3 Kap. 6) */
export interface DaKotrDatei {
  /** auch die eingefrorene Fassung aus dem Cache (wird nur gelesen) */
  datei: Kostentraegerdatei | DeepReadonly<Kostentraegerdatei>;
  kassenart: string;
}

// ───────────────────────── Ergebnis ─────────────────────────

export type FallStatus = "ok" | "fehlend" | "abweichung";

export interface FallPruefung {
  id: string;
  anzeige: string;
  status: FallStatus;
  fehlendeAngaben: string[];
  abweichungen: string[];
  hinweise: string[];
  kasseIk: string | null;
  kasseName: string | null;
  kostentraegerIk: string | null;
  kostentraegerName: string | null;
  davIk: string | null;
  physikalischerEmpfaengerIk: string | null;
  kassenart: string | null;
  belegannahmestelle: Begleitzettel["belegannahmestelle"];
  papierbeleg: boolean;
  /** nur bei „ok“ */
  betraege: { bruttoCent: number; zuzahlungCent: number; rechnungsbetragCent: number } | null;
}

export interface KostentraegerSumme {
  /** IK des Kostenträgers laut Kostenträgerdatei; ohne Datei die Kassen-IK */
  ik: string;
  name: string | null;
  davIk: string | null;
  faelleGesamt: number;
  faelleOk: number;
  bruttoCent: number;
  zuzahlungCent: number;
  rechnungsbetragCent: number;
}

export interface Pruefergebnis {
  stichtag: string;
  /** Mängel der Praxis-Stammdaten – solange nicht leer, entsteht keine Datei */
  praxisFehler: string[];
  /** Mängel des Laufs selbst (z. B. zu viele Verordnungen) – solange nicht leer, entsteht keine Datei */
  laufFehler: string[];
  kotrVorhanden: boolean;
  /** Hinweise zur Kostenträgerdatei (fehlt, mehrdeutig …) */
  kotrHinweise: string[];
  faelle: FallPruefung[];
  summen: KostentraegerSumme[];
  anzahlOk: number;
  /** ob ein Testpaket erzeugt werden kann */
  testpaketMoeglich: boolean;
}

/** Interne Daten je Fall (nicht für die Oberfläche) */
interface FallIntern {
  pruefung: FallPruefung;
  fall: Abrechnungsfall | null;
}

// ───────────────────────── Hilfen ─────────────────────────

/** Mangel eines IK als Text oder null */
const pruefeIk = (ik: string): string | null => (!/^\d{9}$/.test(ik) ? "muss 9 Ziffern haben." : istGueltigesIk(ik) ? null : "Prüfziffer stimmt nicht.");
const ascii = (s: string | null | undefined, max: number) => (s && /^[\x20-\x7e]+$/.test(s.trim()) && s.trim().length <= max ? s.trim() : undefined);
const kuerzen = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Leitsymptomatik a/b/c/x (prescriptions.leitsymptomatik) → Modell; unbekannt → undefined (fehlende Angabe) */
export function leitsymptomatikAus(code: string | null, text: string | null): Pick<ErgaenzendeVerordnungsdaten, "leitsymptomatik" | "leitsymptomatikText"> {
  if (code === "a" || code === "b" || code === "c") {
    return { leitsymptomatik: { art: "heilmittelrichtlinie", a: code === "a", b: code === "b", c: code === "c", patientenindividuell: false } };
  }
  if (code === "x" && text?.trim()) {
    return { leitsymptomatik: { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: true }, leitsymptomatikText: text.trim() };
  }
  return {};
}

/** Preis-Snapshot aus der DB nur in der erwarteten Form übernehmen (sonst null → fehlende Angabe) */
export function snapshotAus(roh: unknown): PreisSnapshot | null {
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return null;
  const s = roh as Record<string, unknown>;
  if (!Array.isArray(s.lines)) return null;
  return {
    lines: s.lines as PreisSnapshot["lines"],
    flatFeeCents: s.flatFeeCents as number,
    complete: s.complete === true,
    notes: Array.isArray(s.notes) ? (s.notes as string[]) : undefined,
  };
}

/** Praxis-Modell für die Nutzdatei; Mängel als verständliche Texte */
export function praxisModell(p: DaPraxis): { praxis: Praxis | null; fehler: string[] } {
  const fehler: string[] = [];
  const ik = (p.ik ?? "").replace(/\s+/g, "");
  if (!ik) fehler.push("IK der Praxis fehlt (Einstellungen → Praxis → Kassenzulassung).");
  else if (pruefeIk(ik)) fehler.push(`IK der Praxis: ${pruefeIk(ik)}`);
  const code = p.legsCode ? ABRECHNUNGSCODE_AUS_LEGS[p.legsCode] : undefined;
  if (!p.legsCode) fehler.push("Leistungserbringergruppe fehlt (Einstellungen → Praxis → Kassenzulassung).");
  else if (!code) fehler.push(`Leistungserbringergruppe ${p.legsCode}: Direktabrechnung ist nur für Podolog:innen (7100501) und Med. Fußpfleger:innen (7200501) vorbereitet (Abrechnungscode 71/72).`);
  const tk = (p.tarifkennzeichen ?? "").trim().toUpperCase();
  if (!tk) fehler.push("Tarifkennzeichen fehlt (Einstellungen → Praxis → Direktabrechnung § 302; steht im Zulassungsbescheid bzw. Vertrag).");
  else if (!istGueltigesTarifkennzeichen(tk)) fehler.push(`Tarifkennzeichen „${tk}“ ist ungültig (5 Stellen: Tarifbereich + Sondertarif, Anlage 3 8.1.5.2).`);
  if (!p.strasse?.trim() || !p.plz?.trim() || !p.ort?.trim()) fehler.push("Anschrift der Praxis unvollständig (Straße, PLZ, Ort – Pflicht für den Begleitzettel).");
  if (!p.name.trim()) fehler.push("Name der Praxis fehlt.");
  if (fehler.length || !code) return { praxis: null, fehler };
  return {
    praxis: {
      ik,
      // NAM Name 1 ..30 (TA1 5.5.2): längere Namen werden gekürzt
      name: kuerzen(p.name.trim(), 30),
      telefon: p.telefon ? kuerzen(p.telefon.trim(), 30) : undefined,
      // NAM Name 4 ..70, nur ASCII (keine Umlaute)
      email: ascii(p.email, 70),
      anschrift: { strasse: p.strasse!.trim(), plz: p.plz!.trim(), ort: p.ort!.trim() },
      abrechnungscode: code,
      tarifkennzeichen: tk,
    },
    fehler,
  };
}

/** TA-Version nach dem Erstelldatum (TA1 V22 ab 01.02.2027, V21 bis 30.04.2027) */
export function taVersionFuer(datum: string): TaVersion {
  return datum >= "2027-02-01" ? "22" : "21";
}

/** Kassenart aus dem Dateinamen der Kostenträgerdatei („AO05Q426.KE2“); der UNB-Name trägt keinen Punkt */
export function kassenartAus(dateiname: string): string | null {
  const mitPunkt = /\./.test(dateiname) ? dateiname : dateiname.length > 3 ? `${dateiname.slice(0, -3)}.${dateiname.slice(-3)}` : dateiname;
  return pruefeKotrDateiname(mitPunkt)?.kassenart ?? null;
}

// ───────────────────────── Prüflauf ─────────────────────────

interface Aufloesung {
  kostentraegerIk: string;
  kostentraegerName: string;
  davIk: string;
  physIk: string;
  /** null = Kostenträger steht in keiner Datei mit gültigem Dateinamen (dann keine Gruppierung möglich) */
  kassenart: string | null;
  kasseName: string;
  belegannahmestelle: Begleitzettel["belegannahmestelle"];
  hinweise: string[];
}

class KotrAufloeser {
  private readonly verzeichnis: KostentraegerVerzeichnis;
  private readonly kassenart = new Map<string, string>();
  constructor(dateien: DaKotrDatei[]) {
    this.verzeichnis = new KostentraegerVerzeichnis(dateien.map((d) => d.datei));
    // nur echte Kassenarten (2 Großbuchstaben aus dem Dateinamen, Anhang 3 Kap. 6) – nie ein Platzhalter
    for (const d of dateien) if (/^[A-Z]{2}$/.test(d.kassenart)) for (const i of d.datei.institutionen) if (!this.kassenart.has(i.ik)) this.kassenart.set(i.ik, d.kassenart);
  }
  loese(kasseIk: string, stichtag: string, praxis: Praxis | null, bundesland?: string | null): Aufloesung {
    const e = this.verzeichnis.ermittle({ kasseIk, stichtag, abrechnungscode: praxis?.abrechnungscode ?? "71", tarifkennzeichen: praxis?.tarifkennzeichen, bundesland: bundesland ?? undefined });
    const karte = this.verzeichnis.institution(kasseIk, stichtag);
    const beleg = e.belegannahmestellen[0];
    const ans = beleg?.anschriften[0];
    return {
      kostentraegerIk: e.kostentraeger.ik,
      kostentraegerName: e.kostentraeger.name,
      davIk: e.datenannahmestelle.ik,
      physIk: e.physikalischerEmpfaenger.ik,
      // Kassenart der Datei, in der der Kostenträger steht (eine Nutzdatei je DAV und Kassenart, TA1 Kap. 3 Abs. 1)
      kassenart: this.kassenart.get(e.kostentraeger.ik) ?? this.kassenart.get(kasseIk) ?? null,
      kasseName: karte ? karte.name.join(" ") || karte.kurzbezeichnung : e.kostentraeger.name,
      belegannahmestelle: beleg ? { ik: beleg.ik, name: beleg.name, anschrift: ans ? { strasse: ans.strasseOderPostfach ?? "", plz: ans.plz, ort: ans.ort } : undefined } : undefined,
      hinweise: e.hinweise,
    };
  }
}

/** Datei mit genau einem Fall – für die TA1-Prüfung im Prüflauf (Nummern sind Platzhalter) */
function einzelDatei(praxis: Praxis, fall: Abrechnungsfall, kasseIk: string, ktIk: string, davIk: string, datum: string): Nutzdatendatei {
  return {
    taVersion: taVersionFuer(datum),
    absender: { ik: praxis.ik, art: "S" },
    empfaengerIk: davIk,
    erstellt: { datum, uhrzeit: "12:00" },
    datenaustauschreferenz: 1,
    dateiart: "test",
    abrechnungsmonat: Number(datum.slice(5, 7)),
    rechnungsart: "1",
    zuzahlungProzent: ZUZAHLUNG_PROZENT,
    zuzahlungPauschaleCent: ZUZAHLUNG_PAUSCHALE_CENT,
    leistungserbringer: [{ praxis, kostentraeger: [{ kostentraegerIk: ktIk, rechnungen: [{ kasseIk, rechnungsnummer: "PRUEF-1", rechnungsdatum: datum, verarbeitungskennzeichen: "01", faelle: [fall] }] }] }],
  };
}

function bildeIntern(praxisDaten: DaPraxis, verordnungen: DaVerordnung[], kotr: DaKotrDatei[], stichtag: string): { ergebnis: Pruefergebnis; intern: FallIntern[]; praxis: Praxis | null } {
  const { praxis, fehler: praxisFehler } = praxisModell(praxisDaten);
  const kotrHinweise: string[] = [];
  const aufloeser = kotr.length ? new KotrAufloeser(kotr) : null;
  if (!aufloeser) kotrHinweise.push("Keine Kostenträgerdatei hinterlegt: Kostenträger und Datenannahmestelle lassen sich nicht ermitteln. Bitte unter Einstellungen → Praxis → Direktabrechnung § 302 die aktuelle Kostenträgerdatei (gkv-datenaustausch.de) hochladen.");
  // der Server lädt höchstens MAX + 1 Zeilen – die genaue Anzahl ist dann unbekannt
  const laufFehler: string[] = [];
  if (verordnungen.length > MAX_FAELLE_JE_LAUF) laufFehler.push(`Mehr als ${MAX_FAELLE_JE_LAUF} Verordnungen in einem Lauf – bitte in kleineren Abrechnungsläufen prüfen (höchstens ${MAX_FAELLE_JE_LAUF}).`);

  const intern: FallIntern[] = verordnungen.slice(0, MAX_FAELLE_JE_LAUF).map((v) => {
    const fehlend: string[] = [];
    const abweichungen: string[] = [];
    const hinweise: string[] = [];
    const snapshot = snapshotAus(v.priceSnapshot);
    if (!snapshot) fehlend.push("Preis-Snapshot fehlt (Verordnung erneut auf „abrechnungsreif“ setzen).");
    const vo: PodoHeroVerordnung = {
      id: v.id,
      issuedAt: v.issuedAt,
      doctorLanr: v.doctorLanr,
      doctorBsnr: v.doctorBsnr,
      diagnosisGroup: v.diagnosisGroup,
      icd10: v.icd10,
      homeVisit: v.homeVisit,
      urgent: v.urgent,
      copaymentExempt: v.copaymentExempt,
      therapyReportRequested: v.therapyReportRequested,
      externalRef: v.externalRef,
      source: v.source,
    };
    const kasseIk = (v.insurerIk ?? v.patient.insurerIk ?? "").replace(/\s+/g, "") || null;
    const pat: PodoHeroPatient = {
      lastName: v.patient.lastName,
      firstName: v.patient.firstName ?? "",
      birthDate: v.patient.birthDate ?? "",
      street: v.patient.street,
      zip: v.patient.zip,
      city: v.patient.city,
      insuranceNumber: v.insuranceNumber ?? v.patient.insuranceNumber,
      insuranceStatus: v.insuredStatus ?? v.patient.insuredStatus,
      insurerIk: kasseIk,
    };
    const ergaenzung: ErgaenzendeVerordnungsdaten = {
      // Kennzeichen Verordnungsart (Anlage 3 8.1.12): ohne Angabe meldet der Adapter eine fehlende Angabe
      verordnungsart: v.verordnungsart ?? undefined,
      ...(v.verordnungsbesonderheit && (VERORDNUNGSBESONDERHEIT as readonly string[]).includes(v.verordnungsbesonderheit)
        ? { verordnungsbesonderheit: v.verordnungsbesonderheit as NonNullable<ErgaenzendeVerordnungsdaten["verordnungsbesonderheit"]> }
        : {}),
      ...(v.genehmigung ? { genehmigung: { kennzeichen: v.genehmigung.kennzeichen, datum: v.genehmigung.datum, art: "B2" as const } } : {}),
      ...leitsymptomatikAus(v.leitsymptomatik, v.leitsymptomatikText),
      diagnosetext: v.diagnosisText ?? undefined,
      befreiungen: Array.isArray(v.patient.copaymentExemptions) ? (v.patient.copaymentExemptions as ErgaenzendeVerordnungsdaten["befreiungen"]) : [],
      verarbeitungskennzeichen: "01",
      zuzahlungProzent: ZUZAHLUNG_PROZENT,
      zuzahlungPauschaleCent: ZUZAHLUNG_PAUSCHALE_CENT,
      // keine Umschlüsselung ZL → KH/KB: in der Erprobung nur Podolog:innen/Med. Fußpfleger:innen (ZL, 71/72, praxisModell)
    };
    const abb = bildeAbrechnungsfall("1", vo, pat, snapshot ?? [], ergaenzung);
    fehlend.push(...abb.fehlendeAngaben);
    abweichungen.push(...abb.abweichungen);
    hinweise.push(...abb.hinweise);
    if (kasseIk && pruefeIk(kasseIk)) fehlend.push(`IK der Krankenkasse: ${pruefeIk(kasseIk)}`);

    let auf: Aufloesung | null = null;
    if (kasseIk && !pruefeIk(kasseIk)) {
      if (aufloeser) {
        try {
          auf = aufloeser.loese(kasseIk, stichtag, praxis, praxisDaten.kotrBundesland);
          hinweise.push(...auf.hinweise);
          if (!auf.kassenart) fehlend.push("Kassenart nicht ermittelbar (Kostenträger in keiner hinterlegten Kostenträgerdatei mit gültigem Dateinamen).");
        } catch (e) {
          if (!(e instanceof KotrFehler)) throw e;
          fehlend.push(`Kostenträger/Datenannahmestelle nicht ermittelbar: ${e.message}`);
        }
      }
    }

    // TA1-Prüfung als Einzelfall (Feldlängen, Formate, Kombinationen), nur wenn sonst alles stimmt
    if (!praxis && !fehlend.length && !abweichungen.length) hinweise.push("TA1-Einzelprüfung nicht ausgeführt, weil die Praxisdaten unvollständig sind.");
    if (praxis && !fehlend.length && !abweichungen.length) {
      try {
        erzeugeNutzdatendatei(einzelDatei(praxis, abb.fall, kasseIk!, auf?.kostentraegerIk ?? kasseIk!, auf?.davIk ?? kasseIk!, stichtag));
      } catch (e) {
        if (!(e instanceof Gkv302ValidierungsFehler)) throw e;
        // Pfade ohne Patientendaten, Meldungen der Bibliothek (Segment/Feld)
        for (const f of e.fehler.filter((x) => !x.pfad.includes("praxis"))) fehlend.push(`Prüfung TA1: ${f.meldung}`);
      }
    }
    // ohne Kostenträgerdatei kann der Fall geprüft, aber nicht in eine Datei übernommen werden
    if (!aufloeser && !fehlend.length && !abweichungen.length) hinweise.push("Kostenträger und Datenannahmestelle ohne Kostenträgerdatei nicht ermittelt.");

    const st: FallStatus = abweichungen.length ? "abweichung" : fehlend.length ? "fehlend" : "ok";
    let betraege: FallPruefung["betraege"] = null;
    if (st === "ok") {
      const b = fallBetraege(abb.fall, ZUZAHLUNG_PROZENT, ZUZAHLUNG_PAUSCHALE_CENT, "01");
      betraege = { bruttoCent: b.bruttoCent, zuzahlungCent: b.gesetzlicheZuzahlungCent, rechnungsbetragCent: b.bruttoCent - b.gesetzlicheZuzahlungCent - b.korrekturabzugCent };
    }
    return {
      fall: st === "ok" ? abb.fall : null,
      pruefung: {
        id: v.id,
        anzeige: v.anzeige,
        status: st,
        fehlendeAngaben: [...new Set(fehlend)],
        abweichungen: [...new Set(abweichungen)],
        hinweise: [...new Set(hinweise)],
        kasseIk,
        kasseName: auf?.kasseName ?? null,
        kostentraegerIk: auf?.kostentraegerIk ?? null,
        kostentraegerName: auf?.kostentraegerName ?? null,
        davIk: auf?.davIk ?? null,
        physikalischerEmpfaengerIk: auf?.physIk ?? null,
        kassenart: auf?.kassenart ?? null,
        belegannahmestelle: auf?.belegannahmestelle,
        papierbeleg: v.source !== "everordnung",
        betraege,
      },
    };
  });

  // Summen je Kostenträger (ohne Kostenträgerdatei je Kassen-IK)
  const summen = new Map<string, KostentraegerSumme>();
  for (const { pruefung: p } of intern) {
    const ik = p.kostentraegerIk ?? p.kasseIk ?? "ohne IK";
    const s = summen.get(ik) ?? { ik, name: p.kostentraegerName ?? p.kasseName, davIk: p.davIk, faelleGesamt: 0, faelleOk: 0, bruttoCent: 0, zuzahlungCent: 0, rechnungsbetragCent: 0 };
    s.faelleGesamt++;
    if (p.betraege) {
      s.faelleOk++;
      s.bruttoCent += p.betraege.bruttoCent;
      s.zuzahlungCent += p.betraege.zuzahlungCent;
      s.rechnungsbetragCent += p.betraege.rechnungsbetragCent;
    }
    summen.set(ik, s);
  }
  const anzahlOk = intern.filter((f) => f.pruefung.status === "ok").length;
  return {
    praxis,
    intern,
    ergebnis: {
      stichtag,
      praxisFehler,
      laufFehler,
      kotrVorhanden: !!aufloeser,
      kotrHinweise,
      faelle: intern.map((f) => f.pruefung),
      summen: [...summen.values()].sort((a, b) => a.ik.localeCompare(b.ik)),
      anzahlOk,
      testpaketMoeglich: !praxisFehler.length && !laufFehler.length && !!aufloeser && anzahlOk > 0,
    },
  };
}

/** Prüflauf: je Verordnung Status, Texte aus dem Adapter und Summen je Kostenträger. Erzeugt nichts. */
export function pruefeFaelle(praxis: DaPraxis, verordnungen: DaVerordnung[], kotr: DaKotrDatei[], stichtag: string): Pruefergebnis {
  return bildeIntern(praxis, verordnungen, kotr, stichtag).ergebnis;
}

// ───────────────────────── Nummernkreise ─────────────────────────

/**
 * Zählerstand je Praxis (in `organizations.settings.gkv302Zaehler`, unter Zeilensperre fortgeschrieben).
 * Testdateien haben einen EIGENEN Kreis (Präfix „T“), damit der spätere Echtbetrieb lückenlos bei 1 beginnt.
 */
export interface Zaehlerstand {
  /** letzte vergebene Rechnungsnummer je Jahr */
  rechnung: Record<string, number>;
  /** letzte Transfernummer (0–999, danach wieder 0) */
  transfer: number;
  /** letzte Datenaustauschreferenz je Empfänger-IK (1–99999, danach wieder 1) */
  dar: Record<string, number>;
}

export function leererZaehlerstand(): Zaehlerstand {
  return { rechnung: {}, transfer: -1, dar: {} };
}

/** liest einen gespeicherten Stand robust (unbekannte Werte → Startwerte) */
export function zaehlerstandAus(roh: unknown): Zaehlerstand {
  const z = leererZaehlerstand();
  if (!roh || typeof roh !== "object") return z;
  const r = roh as Record<string, unknown>;
  const zahlen = (o: unknown) =>
    Object.fromEntries(Object.entries(o && typeof o === "object" ? (o as Record<string, unknown>) : {}).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) as Record<string, number>;
  z.rechnung = zahlen(r.rechnung);
  z.dar = zahlen(r.dar);
  if (Number.isInteger(r.transfer) && (r.transfer as number) >= 0) z.transfer = r.transfer as number;
  return z;
}

export class Nummernkreis {
  constructor(readonly stand: Zaehlerstand, private readonly praefix: "T" | "") {}
  /** Rechnungsnummer über Dateien und Jahre eindeutig: „T2026-00001“ (Test) bzw. „2026-00001“; ..14, nur Buchstaben/Ziffern/„-“ */
  rechnungsnummer(jahr: string): string {
    const n = (this.stand.rechnung[jahr] ?? 0) + 1;
    if (n > 99999) throw new Error(`Nummernkreis ${this.praefix}${jahr} erschöpft.`);
    this.stand.rechnung[jahr] = n;
    return `${this.praefix}${jahr}-${String(n).padStart(5, "0")}`;
  }
  transfernummer(): number {
    this.stand.transfer = (this.stand.transfer + 1) % 1000;
    return this.stand.transfer;
  }
  datenaustauschreferenz(empfaengerIk: string): number {
    const n = (this.stand.dar[empfaengerIk] ?? 0) + 1;
    this.stand.dar[empfaengerIk] = n > 99999 ? 1 : n;
    return this.stand.dar[empfaengerIk];
  }
}

// ───────────────────────── Testpaket ─────────────────────────

export interface Testdatei {
  name: string;
  bytes: Uint8Array;
}

export interface Testpaket {
  dateien: Testdatei[];
  /** je Nutzdatei: Dateiname, Empfänger, Rechnungsnummern, Fallzahl (ohne Patientendaten, fürs Audit) */
  uebersicht: { nutzdatei: string; auftragsdatei: string; logischerDateiname: string; davIk: string; kassenart: string; rechnungsnummern: string[]; faelle: number; bytes: number }[];
  ausgeschlossen: number;
  begleitzettel: Begleitzettel[];
}

export class TestpaketFehler extends Error {
  constructor(readonly meldungen: string[]) {
    super(meldungen.join("\n"));
    this.name = "TestpaketFehler";
  }
}

/** „JJJJ-MM-TT“ → „TT.MM.JJJJ“ */
const de = (iso: string) => iso.split("-").reverse().join(".");
const euro = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} EUR`;

export const WARNUNG_TEST =
  "TESTDATEI – NICHT AN EINE DATENANNAHMESTELLE SENDEN. Verschlüsselung und Signatur (ITSG-Zertifikat, GGT Anlage 16 SECON) fehlen; die Nutzdatei ist unverschlüsselt und als Testdatei gekennzeichnet (Testindikator 0, Dateiname TSOL…).";

/** Begleitzettel als Text (Anlage 4, Pflichtinhalte) */
export function begleitzettelText(z: Begleitzettel): string {
  const zeilen = [
    "*** TEST – NICHT VERSENDEN ***",
    z.titel,
    "",
    `Krankenkasse: ${z.kasse.name} (IK ${z.kasse.ik})`,
    `Rechnungssteller: ${z.rechnungssteller.name} (IK ${z.rechnungssteller.ik})`,
    `                  ${z.rechnungssteller.anschrift.strasse}, ${z.rechnungssteller.anschrift.plz} ${z.rechnungssteller.anschrift.ort}`,
    `Rechnungsnummer: ${z.rechnungsnummer.einzel === "0" ? z.rechnungsnummer.sammel : `${z.rechnungsnummer.sammel}:${z.rechnungsnummer.einzel}`}`,
    `Rechnungsdatum: ${de(z.rechnungsdatum)}`,
    `Anzahl Urbelege: ${z.anzahlUrbelege}`,
  ];
  if (z.ersteBelegnummer) zeilen.push(`Erste/letzte Belegnummer: ${z.ersteBelegnummer} / ${z.letzteBelegnummer}`);
  if (z.belegannahmestelle) zeilen.push(`Belegannahmestelle: ${z.belegannahmestelle.name} (IK ${z.belegannahmestelle.ik})`);
  zeilen.push("", `Belege in dieser Reihenfolge (Belegnummer): ${z.belegreihenfolge.join(", ") || "–"}`);
  return zeilen.join("\r\n") + "\r\n";
}

/**
 * Erzeugt das Testpaket aus einem Prüflauf. Nimmt NUR Fälle mit Status „ok“; Praxisfehler, fehlende
 * Kostenträgerdatei oder kein abrechenbarer Fall → `TestpaketFehler`. Die Nummern kommen aus `nummern`
 * (Testkreis); der Aufrufer speichert den neuen Stand nur, wenn das Paket entstanden ist.
 */
export function erzeugeTestpaket(
  praxisDaten: DaPraxis,
  verordnungen: DaVerordnung[],
  kotr: DaKotrDatei[],
  jetzt: { datum: string; uhrzeit: string; sekunde: string },
  nummern: Nummernkreis,
): Testpaket {
  const { ergebnis, intern, praxis } = bildeIntern(praxisDaten, verordnungen, kotr, jetzt.datum);
  const meldungen = [...ergebnis.laufFehler, ...ergebnis.praxisFehler];
  if (!ergebnis.kotrVorhanden) meldungen.push(...ergebnis.kotrHinweise);
  const ok = intern.filter((f) => f.pruefung.status === "ok" && f.fall);
  if (!ok.length) meldungen.push("Kein Fall ist vollständig und ohne Abweichung – es gibt nichts zu erzeugen. Bitte zuerst „Fälle prüfen“ und die gemeldeten Angaben ergänzen.");
  if (meldungen.length || !praxis) throw new TestpaketFehler(meldungen);

  // Gruppen: eine Nutzdatei je Datenannahmestelle (mit Entschlüsselungsbefugnis) und Kassenart
  const gruppen = new Map<string, FallIntern[]>();
  for (const f of ok) {
    const k = `${f.pruefung.davIk}|${f.pruefung.kassenart}`;
    gruppen.set(k, [...(gruppen.get(k) ?? []), f]);
  }
  const jahr = jetzt.datum.slice(0, 4);
  const monat = Number(jetzt.datum.slice(5, 7));
  const dateien: Testdatei[] = [];
  const uebersicht: Testpaket["uebersicht"] = [];
  const alleZettel: Begleitzettel[] = [];
  for (const [, faelle] of [...gruppen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const davIk = faelle[0].pruefung.davIk!;
    const physIk = faelle[0].pruefung.physikalischerEmpfaengerIk ?? davIk;
    // „ok“ setzt eine ermittelte Kassenart voraus (sonst fehlende Angabe, Review-Runde 2 B1)
    const kassenart = faelle[0].pruefung.kassenart!;
    // Kostenträger → Gesamtrechnung je Kassen-IK, Belegnummern je Gesamtrechnung fortlaufend ab 1
    const kts = new Map<string, Map<string, FallIntern[]>>();
    for (const f of faelle) {
      const kt = kts.get(f.pruefung.kostentraegerIk!) ?? new Map<string, FallIntern[]>();
      kt.set(f.pruefung.kasseIk!, [...(kt.get(f.pruefung.kasseIk!) ?? []), f]);
      kts.set(f.pruefung.kostentraegerIk!, kt);
    }
    const rechnungsnummern: string[] = [];
    const belegannahme = new Map<string, Begleitzettel["belegannahmestelle"]>();
    const kostentraeger: KostentraegerAbrechnung[] = [...kts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ktIk, kassen]) => ({
      kostentraegerIk: ktIk,
      rechnungen: [...kassen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kasseIk, fs]): Gesamtrechnung => {
        const nr = nummern.rechnungsnummer(jahr);
        rechnungsnummern.push(nr);
        belegannahme.set(kasseIk, fs[0].pruefung.belegannahmestelle);
        return {
          kasseIk,
          kasseName: fs[0].pruefung.kasseName ?? undefined,
          rechnungsnummer: nr,
          rechnungsdatum: jetzt.datum,
          verarbeitungskennzeichen: "01",
          faelle: fs.map((f, i) => ({ ...f.fall!, belegnummer: String(i + 1) })),
        };
      }),
    }));
    const d: Nutzdatendatei = {
      taVersion: taVersionFuer(jetzt.datum),
      absender: { ik: praxis.ik, art: "S" },
      empfaengerIk: davIk,
      erstellt: { datum: jetzt.datum, uhrzeit: jetzt.uhrzeit },
      datenaustauschreferenz: nummern.datenaustauschreferenz(davIk),
      dateiart: "test",
      abrechnungsmonat: monat,
      rechnungsart: "1",
      zuzahlungProzent: ZUZAHLUNG_PROZENT,
      zuzahlungPauschaleCent: ZUZAHLUNG_PAUSCHALE_CENT,
      leistungserbringer: [{ praxis, kostentraeger }],
    };
    // doppelte Absicherung: Prüfstufen der Bibliothek über die ganze Datei
    const pruef = pruefeNutzdatendatei(d);
    if (pruef.length) throw new TestpaketFehler(pruef.map((f) => `Prüfung TA1: ${f.meldung}`));
    let nutz: NutzdateiErgebnis;
    try {
      nutz = erzeugeNutzdatendatei(d);
    } catch (e) {
      if (e instanceof Gkv302ValidierungsFehler) throw new TestpaketFehler(e.fehler.map((f) => `Prüfung TA1: ${f.meldung}`));
      throw e;
    }
    const transfer = nummern.transfernummer();
    const physisch = physikalischerDateiname("test", transfer);
    const auftrag = erzeugeAuftragsdatei({
      dateiart: "test",
      transfernummer: transfer,
      absenderEigner: praxis.ik,
      empfaengerNutzer: davIk,
      empfaengerPhysikalisch: physIk,
      dateiname: nutz.logischerDateiname,
      erstellt: `${jetzt.datum} ${jetzt.uhrzeit}:${jetzt.sekunde}`,
      groesseNutzdaten: nutz.bytes.length,
      // unverschlüsselt: Übertragungsgröße = Nutzdatengröße, Verschlüsselungsart/Signatur „00“
      groesseUebertragung: nutz.bytes.length,
      verschluesselt: false,
      emailAbsender: praxis.email,
    });
    const ordner = `${physisch}_${kassenart}_DAV-${davIk}`;
    dateien.push({ name: `${ordner}/${physisch}`, bytes: nutz.bytes });
    dateien.push({ name: `${ordner}/${auftrag.name}`, bytes: auftrag.bytes });
    const zettel = erstelleBegleitzettel(d, nutz, (kasseIk) => belegannahme.get(kasseIk));
    for (const z of zettel) {
      if (!z.anzahlUrbelege) continue;
      const nr = z.rechnungsnummer.einzel === "0" ? z.rechnungsnummer.sammel : `${z.rechnungsnummer.sammel}-${z.rechnungsnummer.einzel}`;
      dateien.push({ name: `${ordner}/Begleitzettel_${nr}_Kasse-${z.kasse.ik}.txt`, bytes: new TextEncoder().encode(begleitzettelText(z)) });
      alleZettel.push(z);
    }
    uebersicht.push({ nutzdatei: physisch, auftragsdatei: auftrag.name, logischerDateiname: nutz.logischerDateiname, davIk, kassenart, rechnungsnummern, faelle: faelle.length, bytes: nutz.bytes.length });
  }
  const liesmich = [
    WARNUNG_TEST,
    "",
    `Erstellt: ${de(jetzt.datum)} ${jetzt.uhrzeit} · Praxis-IK ${praxis.ik} · TA1 Version ${taVersionFuer(jetzt.datum)}`,
    `Übernommene Fälle: ${ok.length} · nicht übernommen (fehlende Angaben/Abweichungen): ${intern.length - ok.length}`,
    "",
    ...uebersicht.map((u) => `${u.nutzdatei} (${u.logischerDateiname}, ${u.bytes} Byte) → Datenannahmestelle ${u.davIk}, Kassenart ${u.kassenart}, Rechnungen ${u.rechnungsnummern.join(", ")}, ${u.faelle} Fälle`),
    "",
    "Inhalt je Ordner: Nutzdatei (TSOL0nnn, ISO 8859-1, unverschlüsselt), Auftragsdatei (.AUF, 348 Byte, Verschlüsselung 00),",
    "Begleitzettel je Gesamtrechnung mit Papierbelegen (Text; PDF: Begleitzettel_TEST.pdf im Hauptordner).",
    "Rechnungsnummern stammen aus dem eigenen Test-Nummernkreis (Präfix T) und sind keine Rechnungen.",
    `Summe Rechnungsbetrag (ohne Gewähr): ${euro(ok.reduce((s, f) => s + (f.pruefung.betraege?.rechnungsbetragCent ?? 0), 0))}`,
  ].join("\r\n");
  dateien.unshift({ name: "LIESMICH_TEST_NICHT_VERSENDEN.txt", bytes: new TextEncoder().encode(liesmich + "\r\n") });
  return { dateien, uebersicht, ausgeschlossen: intern.length - ok.length, begleitzettel: alleZettel };
}
