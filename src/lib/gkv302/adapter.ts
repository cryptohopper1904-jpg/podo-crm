/**
 * Adapter-Schnittstelle: PodoHero-Daten → Datenmodell § 302. Nur Typen und eine reine Abbildungsfunktion,
 * keine DB-Zugriffe und keine Schemaänderung in diesem Paket.
 *
 * Die Quellfelder spiegeln den heutigen Stand von `prescriptions`/`patients` (src/db/schema.ts). Was die TA1
 * zusätzlich verlangt und dort noch fehlt, meldet `bildeAbrechnungsfall` als `fehlendeAngaben`; diese Felder
 * müssen vor dem echten Einsatz im Schema ergänzt werden (siehe docs/GKV-302.md, „Offene Punkte“).
 */
import type { Abrechnungsfall, Einzelleistung, Leitsymptomatik, Verordnung, Versicherter } from "./typen";
import type { Verarbeitungskennzeichen, Verordnungsart, Zuzahlungskennzeichen } from "./schluessel";
import { fallBetraege } from "./betraege";
import { ZUZAHLUNG_PAUSCHALE_CENT, datumGueltig } from "./nutzdatei";

/** Verordnung, wie PodoHero sie heute speichert (Auszug) */
export interface PodoHeroVerordnung {
  id: string;
  issuedAt: string;
  doctorLanr?: string | null;
  doctorBsnr?: string | null;
  diagnosisGroup: string;
  icd10?: string | null;
  homeVisit: boolean;
  urgent: boolean;
  copaymentExempt: boolean;
  therapyReportRequested: boolean;
  /** eVerordnung-Referenz */
  externalRef?: string | null;
  source: "paper" | "ocr" | "everordnung" | string;
}

export interface PodoHeroPatient {
  lastName: string;
  firstName: string;
  birthDate: string;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  insuranceNumber?: string | null;
  /** Versichertenstatus von der Verordnung (heute nicht gespeichert) */
  insuranceStatus?: string | null;
  /** IK der Krankenkasse von der Verordnung */
  insurerIk?: string | null;
}

/**
 * Snapshot-Vertrag mit PR #111 (`priceSnapshot` in src/lib/rules/prescription.ts), hier ohne Code-Abhängigkeit
 * nachgebildet: eine Zeile je Termin (Datum) und Position. Der Adapter fasst nichts zusammen und erfindet keine
 * Beträge: gleiche Positionen am selben Tag müssen schon im Snapshot eine Zeile sein (TA1 V21 5.5.3.3 EHE
 * Anzahl/Menge, S. 66).
 */
export interface PreisSnapshotZeile {
  /** Behandlungstag "JJJJ-MM-TT" */
  date: string;
  /**
   * 5-stellige Heilmittelpositionsnummer für zugelassene Leistungserbringer (ZL, 78xxx/79xxx; Anlage 2 § 1 Abs. 2).
   * Für Praxen mit Status KH/KB schlüsselt `ErgaenzendeVerordnungsdaten.positionsnummer` um (#111: `hpnrFor`).
   */
  position: string;
  units: number;
  /** vereinbarter Preis je Einheit in Cent; `null` = kein Preis hinterlegt (→ fehlende Angabe) */
  priceCents: number | null;
  /**
   * Zuzahlung dieser Zeile in Cent: `null` = Position ohne Zuzahlung laut Vergütungsliste (Anlage 2, Spalte „-“ bzw.
   * leer, z. B. 78220, 78530); `0` = an diesem Termin keine Zuzahlung (unter 18 oder befreit); `> 0` = Zuzahlung.
   */
  copayCents: number | null;
  /** an diesem Termin unter 18 (falls geliefert; wird gegen das Geburtsdatum geprüft) */
  minor?: boolean;
  /** an diesem Termin befreit (falls geliefert; wird gegen die Befreiungszeiträume geprüft) */
  exempt?: boolean;
  /** gefahrene Kilometer bei Wegegeld je km (Podologie: Hausbesuch inkl. Wegegeld, daher meist leer) */
  kilometers?: number;
}

/** Preis-Snapshot einer Verordnung (Auszug aus #111 `PriceSnapshot`) */
export interface PreisSnapshot {
  lines: PreisSnapshotZeile[];
  /**
   * Pauschale je Verordnung in Cent: 0 bis 1000, höchstens Heilmittelkosten − prozentuale Zuzahlung (#111 deckelt
   * `min(1000, remedy − percent)`, wie TA1 BES pauschaler Zuzahlungsbetrag); Pflicht, sobald ein Snapshot vorliegt
   */
  flatFeeCents: number;
  /** `false`, wenn für mindestens eine Zeile kein Preis gefunden wurde */
  complete: boolean;
  /** Hinweise aus #111 (z. B. Befreiung einer anderen Kasse, Geburtsdatum fehlt); werden als `hinweise` durchgereicht */
  notes?: string[];
}

/** Einzelleistung ohne Preis-Snapshot (Übergang/Altdaten): ohne Zuzahlungsangaben, das Kennzeichen bleibt prüfbedürftig */
export interface PodoHeroBehandlung {
  date: string;
  /** 5-stellige Heilmittelpositionsnummer (ZL) */
  position: string;
  units: number;
  priceCents: number | null;
  kilometers?: number;
}

/** Befreiung nach § 62 SGB V laut Bescheinigung der Kasse ("JJJJ-MM-TT", beide Grenzen einschließlich) */
export interface Befreiungszeitraum {
  von: string;
  bis: string;
  /** IK der Kasse, die die Befreiung ausgestellt hat; weicht es vom IK der Verordnung ab → Hinweis (keine Sperre) */
  insurerIk?: string | null;
}

/** Dieselbe Befreiung in der Form von #111 (`CopaymentExemption`); wird auf `Befreiungszeitraum` normalisiert */
export interface BefreiungszeitraumSnapshot {
  validFrom: string;
  validTo: string;
  insurerIk?: string | null;
}

/** Angaben, die PodoHero heute nicht speichert, aber die TA1 verlangt */
export interface ErgaenzendeVerordnungsdaten {
  verordnungsart?: Verordnungsart;
  leitsymptomatik?: Leitsymptomatik;
  leitsymptomatikText?: string;
  /**
   * Nur für Sonderfälle (z. B. „2“ oder „5“ bei VKZ 03); sonst wird das Kennzeichen abgeleitet, nie aus dem Kreuz
   * „gebührenfrei“. Mit Snapshot setzt der Adapter die Angaben je Position und die Pauschale aus dem Snapshot und
   * rechnet mit `verarbeitungskennzeichen` gegen (ohne Angabe „01“). Bei VKZ ≠ „03“ entfällt nur die automatische
   * Ableitung: Alle Prüfungen gegen Alter/Befreiung/Kreuz/Pauschale laufen weiter, und ein Kennzeichen, das dem
   * abgeleiteten widerspricht, ist eine Abweichung (außer „2“). Review-Runde 4, B1.
   */
  zuzahlungskennzeichen?: Zuzahlungskennzeichen;
  /** Verarbeitungskennzeichen der Gesamtrechnung, in die der Fall geht (für die Gegenrechnung; Standard „01“) */
  verarbeitungskennzeichen?: Verarbeitungskennzeichen;
  diagnosetext?: string;
  /** Zuzahlungsbefreiungen (§ 62 SGB V), auch mehrere (z. B. je Kalenderjahr); `{von, bis}` oder `{validFrom, validTo}` */
  befreiungen?: (Befreiungszeitraum | BefreiungszeitraumSnapshot)[];
  /**
   * Kreuz „gebührenfrei“ auf der Verordnung, aber keine Befreiungsbescheinigung: Die Praxis hat geprüft und bestätigt,
   * dass Zuzahlung anfällt. Dann gilt der Fall als zuzahlungspflichtig (ZK und Zuzahlung wie ohne Kreuz) und es
   * entsteht ein Hinweis statt einer Abweichung bzw. fehlenden Angabe (siehe docs/GKV-302.md, Abschnitt 2b).
   */
  kreuzOhneBescheinigungBestaetigt?: boolean;
  /** Zuzahlungsprozentsatz für die Gegenrechnung (Standard 10, § 61 Satz 3 SGB V) */
  zuzahlungProzent?: number;
  /**
   * Pauschale je Verordnung für die Gegenrechnung, wie `Nutzdatendatei.zuzahlungPauschaleCent` (Standard 1000); die
   * Gegenrechnung deckelt sie auf Brutto − prozentuale Zuzahlung (`fallBetraege`)
   */
  zuzahlungPauschaleCent?: number;
  /**
   * Umschlüsselung der ZL-Positionsnummer aus dem Snapshot auf den Status der Praxis (Anlage 2 § 1 Abs. 2: ZL 7xxxx,
   * KH 6xxxx, KB 8xxxx), z. B. `(zl) => hpnrFor(zl, praxis.status)` aus #111. Ohne Angabe bleibt die ZL-Nummer.
   */
  positionsnummer?: (zlPosition: string) => string;
}

/**
 * Frühester und spätester möglicher Tag des 18. Geburtstags. Unbekannte Tage/Monate („JJJJ-MM-00“, „JJJJ-00-00“,
 * TA1 V21 NAD Geburtsdatum) ergeben einen Zeitraum statt eines Tages.
 */
function achtzehnterGeburtstag(geburtsdatum: string): { fruehestens: string; spaetestens: string } | null {
  // Hinweis 3: echte Kalenderprüfung (2010-02-30 → unbrauchbar); unbekannter Tag/Monat („00“) bleibt zulässig
  if (typeof geburtsdatum !== "string" || !datumGueltig(geburtsdatum, true)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(geburtsdatum);
  if (!m) return null;
  const jahr = String(Number(m[1]) + 18).padStart(4, "0");
  const [mo, t] = [m[2], m[3]];
  if (mo === "00") return { fruehestens: `${jahr}-01-01`, spaetestens: `${jahr}-12-31` };
  if (t === "00") return { fruehestens: `${jahr}-${mo}-01`, spaetestens: `${jahr}-${mo}-31` };
  // 29.02. → in Nicht-Schaltjahren vollendet am 01.03. (§ 187 Abs. 2, § 188 Abs. 2 BGB): Textvergleich genügt
  return { fruehestens: `${jahr}-${mo}-${t}`, spaetestens: `${jahr}-${mo}-${t}` };
}

type TerminStatus = "pflichtig" | "frei" | "unklar";
type Grund = "alter" | "befreiung";

/** echtes Kalenderdatum „JJJJ-MM-TT“ (Hinweis 3: 2026-02-30 ist keins) */
const istDatum = (d: unknown): d is string => typeof d === "string" && datumGueltig(d);

/**
 * S6: `{von, bis}` (eigene Form) und `{validFrom, validTo}` (#111 `CopaymentExemption`) auf eine Form bringen.
 * Hinweis 2: `null` oder kein Objekt ergibt einen leeren (unbrauchbaren) Zeitraum statt eines TypeError.
 */
function normalisiereBefreiung(b: Befreiungszeitraum | BefreiungszeitraumSnapshot | null | undefined): Befreiungszeitraum {
  const roh = (b !== null && typeof b === "object" ? b : {}) as Partial<Befreiungszeitraum & BefreiungszeitraumSnapshot>;
  const von = roh.von ?? roh.validFrom;
  const bis = roh.bis ?? roh.validTo;
  return { von: typeof von === "string" ? von : "", bis: typeof bis === "string" ? bis : "", insurerIk: roh.insurerIk };
}

/** gültige Befreiungszeiträume (normalisiert); `null`, wenn mindestens einer unbrauchbar ist */
function befreiungszeitraeume(e: ErgaenzendeVerordnungsdaten): Befreiungszeitraum[] | null {
  const liste = (e.befreiungen ?? []).map(normalisiereBefreiung);
  return liste.every((b) => istDatum(b.von) && istDatum(b.bis) && b.von <= b.bis) ? liste : null;
}

/**
 * V2: ob ein Befreiungszeitraum den Termin enthält – unabhängig vom Alter (#111 setzt `exempt` auch bei
 * Minderjährigen). `null` = Zeiträume unbrauchbar.
 */
function befreitAm(datum: string, e: ErgaenzendeVerordnungsdaten): boolean | null {
  const zeitraeume = befreiungszeitraeume(e);
  return zeitraeume === null ? null : zeitraeume.some((b) => b.von <= datum && datum <= b.bis);
}

const HINWEIS_KREUZ = "Kreuz „gebührenfrei“ auf der Verordnung ohne Befreiungsbescheinigung: laut Bestätigung der Praxis als zuzahlungspflichtig abgerechnet (kreuzOhneBescheinigungBestaetigt).";

/** S4: Kreuz „gebührenfrei“ ohne Zeitraum, von der Praxis als zuzahlungspflichtig bestätigt */
function kreuzBestaetigt(vo: PodoHeroVerordnung, e: ErgaenzendeVerordnungsdaten): boolean {
  return vo.copaymentExempt && e.kreuzOhneBescheinigungBestaetigt === true;
}

/**
 * Erwarteter Zuzahlungsstatus je Termin aus Alter und Befreiungszeiträumen:
 * - unter 18 am Behandlungstag: keine gesetzliche Zuzahlung (§ 32 Abs. 2 Satz 1 SGB V: Zuzahlung erst nach
 *   Vollendung des 18. Lebensjahres) → frei;
 * - Befreiung (§ 62 SGB V) mit Gültigkeitszeitraum, der den Termin enthält → frei;
 * - Kreuz „gebührenfrei“ ohne Zeitraum oder unklares Geburtsdatum → unklar (wird nie still als „3“ gewertet).
 */
function terminStatus(datum: string, vo: PodoHeroVerordnung, patient: PodoHeroPatient, e: ErgaenzendeVerordnungsdaten): { status: TerminStatus; grund?: Grund } {
  const geb18 = achtzehnterGeburtstag(patient.birthDate);
  if (!geb18) return { status: "unklar" };
  if (datum < geb18.fruehestens) return { status: "frei", grund: "alter" };
  if (datum < geb18.spaetestens) return { status: "unklar", grund: "alter" };
  const zeitraeume = befreiungszeitraeume(e);
  if (zeitraeume === null) return { status: "unklar", grund: "befreiung" };
  if (zeitraeume.length) return zeitraeume.some((b) => b.von <= datum && datum <= b.bis) ? { status: "frei", grund: "befreiung" } : { status: "pflichtig" };
  if (vo.copaymentExempt && !kreuzBestaetigt(vo, e)) return { status: "unklar", grund: "befreiung" };
  return { status: "pflichtig" };
}

/** Kennzeichen aus einer zeitlich sortierten Folge von Status (Anlage 3 V21 8.1.3, S. 10) */
function kennzeichenAusFolge(folge: ("pflichtig" | "frei")[], freiGrund: Grund | undefined): Zuzahlungskennzeichen | null {
  if (folge.every((x) => x === "pflichtig")) return "3";
  if (folge.every((x) => x === "frei")) return freiGrund === "alter" ? "0" : "1";
  const wechsel = folge.findIndex((x, i) => i > 0 && x !== folge[i - 1]);
  const einWechsel = folge.slice(wechsel).every((x) => x === folge[wechsel]);
  if (!einWechsel) return null;
  return folge[0] === "pflichtig" ? "4" : "5";
}

/** Einheitliche Zeile für beide Eingabeformen; `copayCents` undefined = ohne Snapshot */
interface Zeile {
  date: string;
  position: string;
  units: number;
  priceCents: number | null;
  copayCents?: number | null;
  minor?: boolean;
  exempt?: boolean;
  kilometers?: number;
}

interface Zuzahlung {
  zk: Zuzahlungskennzeichen;
  jePosition?: boolean[];
  pauschale?: boolean;
  /** ob die Snapshot-Beträge gegen die eigene Rechnung geprüft werden (mit diesem VKZ) */
  gegenrechnung?: Verarbeitungskennzeichen;
}

const FEHLT_ALTER = "18. Geburtstag fällt in den Behandlungszeitraum: Zuzahlungskennzeichen (5) und Zuzahlung je Termin manuell festlegen";
const FEHLT_SNAPSHOT = "Preis-Snapshot der Verordnung (priceSnapshot: Zuzahlung je Einzelleistung und Pauschale)";
const FEHLT_GEBURTSDATUM = "Geburtsdatum im Format JJJJ-MM-TT (für die Prüfung „unter 18“)";
const FEHLT_WECHSEL = "Befreiung beginnt oder endet im Behandlungszeitraum: Zuzahlungskennzeichen (4 oder 5) und Zuzahlung je Termin manuell festlegen";

/** Ohne Snapshot: Kennzeichen nur aus Alter und Befreiungszeiträumen; ZK 3 braucht den Snapshot (Zuzahlung je Position) */
function ohneSnapshot(vo: PodoHeroVerordnung, patient: PodoHeroPatient, sortiert: Zeile[], e: ErgaenzendeVerordnungsdaten, fehlend: string[]): Zuzahlung {
  const erwartet = sortiert.map((z) => terminStatus(z.date, vo, patient, e));
  const freiGrund = erwartet.find((x) => x.status === "frei")?.grund;
  if (erwartet.some((x) => x.status === "unklar")) {
    if (erwartet.some((x) => x.grund === "alter" && x.status === "unklar")) fehlend.push(FEHLT_ALTER);
    else if (!achtzehnterGeburtstag(patient.birthDate)) fehlend.push(FEHLT_GEBURTSDATUM);
    else if (befreiungszeitraeume(e) !== null) fehlend.push("Zeitraum der Zuzahlungsbefreiung (gültig von–bis laut Befreiungsbescheinigung)");
    return { zk: vo.copaymentExempt ? "1" : "3" };
  }
  const zk = kennzeichenAusFolge(erwartet.map((x) => x.status as "pflichtig" | "frei"), freiGrund);
  if ((zk === "5" || zk === null) && freiGrund === "alter") {
    fehlend.push(FEHLT_ALTER);
    return { zk: "3" };
  }
  if (zk === "4" || zk === "5" || zk === null) {
    fehlend.push(FEHLT_WECHSEL);
    return { zk: "3" };
  }
  if (zk === "3") fehlend.push(FEHLT_SNAPSHOT);
  return { zk };
}

/**
 * Status je Termin aus Alter/Befreiung. V1: Geburtsdatum mit unbekanntem Tag/Monat → „unklar (Alter)“; ist die Zeile
 * im Snapshot als „unter 18“ gekennzeichnet, gilt der Termin als frei wegen Alters (das Datum widerspricht dem nicht).
 */
function effektiverStatus(vo: PodoHeroVerordnung, patient: PodoHeroPatient, sortiert: Zeile[], e: ErgaenzendeVerordnungsdaten): { status: TerminStatus; grund?: Grund }[] {
  return sortiert.map((z) => {
    const x = terminStatus(z.date, vo, patient, e);
    return x.status === "unklar" && x.grund === "alter" && z.minor === true ? { status: "frei" as const, grund: "alter" as const } : x;
  });
}

/** B1: Kennzeichen allein aus Alter/Befreiung (ohne Snapshot-Beträge); `null`, wenn ein Termin unklar ist */
function kennzeichenAusStatus(effektiv: { status: TerminStatus; grund?: Grund }[]): Zuzahlungskennzeichen | null {
  if (!effektiv.length || effektiv.some((x) => x.status === "unklar")) return null;
  return kennzeichenAusFolge(
    effektiv.map((x) => x.status as "pflichtig" | "frei"),
    effektiv.find((x) => x.status === "frei")?.grund,
  );
}

/**
 * Mit Snapshot (D2): Zuzahlung je Einzelleistung und Pauschale sind die Quelle; das Kennzeichen wird daraus
 * abgeleitet und gegen Alter/Befreiung, `minor`/`exempt` je Zeile und das Kreuz „gebührenfrei“ geprüft.
 * Positionen mit `copayCents: null` (ohne Zuzahlung laut Vergütungsliste) zählen für das Kennzeichen nicht.
 */
function mitSnapshot(vo: PodoHeroVerordnung, patient: PodoHeroPatient, sortiert: Zeile[], flat: number, e: ErgaenzendeVerordnungsdaten, abweichungen: string[]): Zuzahlung {
  const ist = (z: Zeile): "pflichtig" | "frei" => ((z.copayCents ?? 0) > 0 ? "pflichtig" : "frei");
  const effektiv = effektiverStatus(vo, patient, sortiert, e);
  // Grund für ZK 0/1; ersatzweise aus den Kennzeichen des Snapshots (minor → Alter, exempt → Befreiung)
  const freiGrund: Grund | undefined =
    effektiv.find((x) => x.status === "frei")?.grund ?? (sortiert.some((z) => z.minor === true) ? "alter" : sortiert.some((z) => z.exempt === true) ? "befreiung" : undefined);
  const relevant = sortiert.filter((z) => z.copayCents !== null);
  const pauschale = flat > 0;

  let zk: Zuzahlungskennzeichen | null;
  if (!relevant.length) {
    // nur zuzahlungsfreie Positionen: mit Pauschale „3“; ohne Pauschale aus der Folge Alter/Befreiung (Hinweis 2:
    // z. B. 18. Geburtstag im Zeitraum → „5“ mit Zuzahlung 0 je Position und ohne Pauschale)
    if (pauschale) zk = "3";
    else if (effektiv.some((x) => x.status === "unklar")) {
      abweichungen.push("Preis-Snapshot enthält nur Positionen ohne Zuzahlung und keine Pauschale, aber Alter (unter 18) bzw. Befreiungszeitraum ist nicht an jedem Termin belegt: Zuzahlungskennzeichen nicht ableitbar.");
      return { zk: "3" };
    } else {
      zk = kennzeichenAusFolge(effektiv.map((x) => x.status as "pflichtig" | "frei"), freiGrund);
      if (zk === null) {
        abweichungen.push("Preis-Snapshot enthält nur Positionen ohne Zuzahlung und keine Pauschale, der Status nach Alter/Befreiung wechselt aber mehrfach im Behandlungszeitraum: Zuzahlungskennzeichen manuell festlegen.");
        return { zk: "3" };
      }
    }
  } else {
    zk = kennzeichenAusFolge(relevant.map(ist), freiGrund);
  }
  if (zk === null) {
    abweichungen.push("Zuzahlung je Termin im Preis-Snapshot ergibt kein eindeutiges Zuzahlungskennzeichen (mehrfacher Wechsel oder Befreiung/Alter nicht belegt).");
    return { zk: "3" };
  }

  // Gegenprüfung je Zeile mit Alter/Befreiung und den Kennzeichen minor/exempt des Snapshots (R2-1)
  sortiert.forEach((z, k) => {
    const wo = `Termin ${z.date}, Position ${z.position}`;
    const soll = effektiv[k];
    if ((z.minor === true || z.exempt === true) && (z.copayCents ?? 0) > 0) abweichungen.push(`${wo}: im Preis-Snapshot als ${z.minor ? "„unter 18“" : "befreit"} gekennzeichnet, aber trotzdem Zuzahlung.`);
    if (z.minor === true && !(soll.grund === "alter" && soll.status !== "pflichtig")) abweichungen.push(`${wo}: im Preis-Snapshot als „unter 18“ gekennzeichnet, laut Geburtsdatum aber volljährig.`);
    if (z.minor === false && soll.grund === "alter" && soll.status === "frei") abweichungen.push(`${wo}: laut Geburtsdatum unter 18, im Preis-Snapshot aber nicht als „unter 18“ gekennzeichnet.`);
    // V2: `exempt` gegen die Befreiungszeiträume selbst prüfen (nicht gegen den Status), da Minderjährigkeit vorgeht
    const befreit = befreitAm(z.date, e);
    if (z.exempt === true && befreit !== true) abweichungen.push(`${wo}: im Preis-Snapshot als befreit gekennzeichnet, aber kein Befreiungszeitraum enthält den Termin.`);
    if (z.exempt === false && befreit === true) abweichungen.push(`${wo}: liegt im Befreiungszeitraum, im Preis-Snapshot aber nicht als befreit gekennzeichnet.`);
    if (z.copayCents === null) return;
    const i = ist(z);
    if (soll.status !== "unklar" && soll.status !== i) abweichungen.push(`${wo}: Preis-Snapshot ${i === "pflichtig" ? "mit" : "ohne"} Zuzahlung, nach Alter/Befreiung aber zuzahlungs${soll.status === "pflichtig" ? "pflichtig" : "frei"}.`);
    if (soll.status === "unklar" && i === "frei") abweichungen.push(`${wo}: Preis-Snapshot ohne Zuzahlung, aber weder „unter 18“ noch ein Befreiungszeitraum ist belegt.`);
  });

  // R2-5: Kreuz „gebührenfrei“, aber Zuzahlung im Snapshot und kein Termin ist frei (weder Befreiungszeitraum noch,
  // V3, Minderjährigkeit – das Kreuz gilt dann dem Kind); S4: von der Praxis bestätigt → Hinweis statt Abweichung
  if (vo.copaymentExempt && relevant.some((z) => ist(z) === "pflichtig") && !effektiv.some((x) => x.status === "frei") && !kreuzBestaetigt(vo, e)) {
    abweichungen.push("Verordnung ist als „gebührenfrei“ gekennzeichnet, der Preis-Snapshot enthält aber Zuzahlung und kein Befreiungszeitraum enthält einen Termin.");
  }

  // R2-6: Pauschale nach dem Status am ersten Behandlungstag (Vertrag Podologie § 8 Abs. 2 Satz 3; #111 flatFeeCents)
  const ersterTag = effektiv[0];
  if (ersterTag && ersterTag.status !== "unklar" && pauschale !== (ersterTag.status === "pflichtig")) {
    abweichungen.push(
      pauschale
        ? `Pauschale im Preis-Snapshot ${flat} Cent, am ersten Behandlungstag ${sortiert[0].date} besteht aber keine Zuzahlungspflicht (${ersterTag.grund === "alter" ? "unter 18" : "befreit"}).`
        : `Pauschale fehlt im Preis-Snapshot, obwohl am ersten Behandlungstag ${sortiert[0].date} Zuzahlungspflicht besteht.`,
    );
  }

  const vkz = e.verarbeitungskennzeichen ?? "01";
  if (zk === "4" || zk === "5") return { zk, jePosition: sortiert.map((z) => ist(z) === "pflichtig"), pauschale, gegenrechnung: vkz };
  return { zk, gegenrechnung: vkz };
}

/**
 * Zuzahlungskennzeichen (Anlage 3 V21 8.1.3). Ändert sich der Status im Behandlungszeitraum und lässt er sich nicht
 * belegen, entsteht eine fehlende Angabe bzw. Abweichung statt eines stillen „3“. Die Angaben je Position
 * (`jePosition`) gelten in der Reihenfolge von `sortiert`.
 */
function ermittleZuzahlung(vo: PodoHeroVerordnung, patient: PodoHeroPatient, sortiert: Zeile[], snapshot: PreisSnapshot | null, e: ErgaenzendeVerordnungsdaten, fehlend: string[], abweichungen: string[]): Zuzahlung {
  const flat = snapshot && Number.isInteger(snapshot.flatFeeCents) && snapshot.flatFeeCents >= 0 ? snapshot.flatFeeCents : null;
  if (e.zuzahlungskennzeichen) {
    // R2-4: vorgegebenes Kennzeichen (Sonderfall, z. B. VKZ 03): Angaben je Position aus dem Snapshot übernehmen und
    // gegenrechnen. F4: ohne VKZ gilt wie in `mitSnapshot` der Standard „01“, damit ein falsches Kennzeichen nicht
    // ungeprüft durchgeht.
    const zk = e.zuzahlungskennzeichen;
    const vkz = e.verarbeitungskennzeichen ?? "01";
    if (vkz !== "03" && sortiert.length) {
      // B1: Nur die automatische Ableitung entfällt. Alle Prüfungen gegen Alter/Befreiung, minor/exempt, Kreuz
      // „gebührenfrei“ (R2-5, auch S4 kreuzBestaetigt) und Pauschale am ersten Tag (R2-6) laufen wie ohne Vorgabe; ein
      // Kennzeichen, das dem aus Alter/Befreiung abgeleiteten widerspricht, ist eine Abweichung. „2“ ist bewusst
      // zulässig (Sonderfall ohne Ableitung). VKZ 03 bleibt unverändert (Kennzeichen nennt nur den Grund, 2a).
      const abgeleitet = kennzeichenAusStatus(effektiverStatus(vo, patient, sortiert, e));
      if (zk !== "2" && abgeleitet !== null && abgeleitet !== zk) abweichungen.push(`Vorgegebenes Zuzahlungskennzeichen ${zk} passt nicht zu Alter/Befreiung (abgeleitet ${abgeleitet}).`);
      if (snapshot && flat !== null) mitSnapshot(vo, patient, sortiert, flat, e, abweichungen);
      else if (!snapshot) {
        // ohne Snapshot: fehlende Grundlagen (Geburtsdatum, Zeitraum der Befreiung) wie bei der Ableitung melden; was
        // das vorgegebene Kennzeichen selbst festlegt (Wechsel 4/5, Snapshot für ZK 3), entfällt
        const vorlaeufig: string[] = [];
        ohneSnapshot(vo, patient, sortiert, e, vorlaeufig);
        fehlend.push(...vorlaeufig.filter((f) => f !== FEHLT_ALTER && f !== FEHLT_WECHSEL && f !== FEHLT_SNAPSHOT));
      }
    }
    if (!snapshot || flat === null) return { zk };
    if (vkz === "03" || zk === "2" || zk === "4" || zk === "5") {
      return { zk, jePosition: sortiert.map((z) => (z.copayCents ?? 0) > 0), pauschale: flat > 0, gegenrechnung: vkz };
    }
    return { zk, gegenrechnung: vkz };
  }
  if (!sortiert.length) return { zk: "3" };
  if (!snapshot) return ohneSnapshot(vo, patient, sortiert, e, fehlend);
  if (flat === null) return { zk: "3" };
  return mitSnapshot(vo, patient, sortiert, flat, e, abweichungen);
}

/** Quelle, die der spätere Server-Code implementiert (DB-Zugriff je Praxis, Rechte, Mandantentrennung) */
export interface PodoHeroAbrechnungsquelle {
  /** abrechnungsreife Verordnungen eines Zeitraums (Status billing_ready) mit dem Preis-Snapshot aus #111 */
  ladeAbrechnungsreife(von: string, bis: string): Promise<{ verordnung: PodoHeroVerordnung; patient: PodoHeroPatient; leistungen: PreisSnapshot | PodoHeroBehandlung[]; ergaenzung: ErgaenzendeVerordnungsdaten }[]>;
}

export interface AbbildungsErgebnis {
  fall: Abrechnungsfall;
  /** Pflichtangaben, die fehlen; solange nicht leer, darf der Fall nicht abgerechnet werden */
  fehlendeAngaben: string[];
  /**
   * Widersprüche zwischen dem Preis-Snapshot (Zuzahlung je Einzelleistung, Pauschale, minor/exempt) und der eigenen
   * Rechnung bzw. Alter/Befreiung/Kreuz „gebührenfrei“; solange nicht leer, darf der Fall ebenfalls nicht abgerechnet
   * werden.
   */
  abweichungen: string[];
  /**
   * Hinweise ohne Sperre: `notes` des Snapshots (#111), Befreiung einer anderen Kasse als auf der Verordnung (S5),
   * bestätigtes Kreuz „gebührenfrei“ ohne Bescheinigung (S4). Vor dem Versand anzeigen.
   */
  hinweise: string[];
}

/**
 * Bildet einen Fall ab. Die Belegnummer vergibt der Aufrufer (eindeutig je Gesamtrechnung, Sortierreihenfolge).
 * `leistungen` ist der Preis-Snapshot der Verordnung (#111, Normalfall) oder – nur für Altdaten – eine Liste von
 * Einzelleistungen ohne Zuzahlungsangaben. Die Einzelleistungen erscheinen im Fall nach Datum sortiert (stabil).
 */
export function bildeAbrechnungsfall(
  belegnummer: string,
  vo: PodoHeroVerordnung,
  patient: PodoHeroPatient,
  leistungenQuelle: PreisSnapshot | PodoHeroBehandlung[],
  ergaenzung: ErgaenzendeVerordnungsdaten,
): AbbildungsErgebnis {
  const snapshot = Array.isArray(leistungenQuelle) ? null : leistungenQuelle;
  const zeilen: Zeile[] = snapshot ? (snapshot.lines ?? []) : (leistungenQuelle as PodoHeroBehandlung[]);
  const sortiert = zeilen.map((z, i) => ({ z, i })).sort((x, y) => (x.z.date < y.z.date ? -1 : x.z.date > y.z.date ? 1 : x.i - y.i)).map(({ z }) => z);

  const fehlend: string[] = [];
  if (!ergaenzung.verordnungsart) fehlend.push("Kennzeichen Verordnungsart (Anlage 3, 8.1.12)");
  if (!ergaenzung.leitsymptomatik) fehlend.push("Leitsymptomatik (a/b/c/patientenindividuell)");
  if (!patient.insuranceStatus) fehlend.push("Versichertenstatus von der Verordnung");
  if (!patient.insurerIk) fehlend.push("IK der Krankenkasse von der Verordnung");
  if (!vo.icd10 && !ergaenzung.diagnosetext) fehlend.push("ICD-10-Code oder Diagnosetext");
  if (!sortiert.length) fehlend.push("mindestens eine erbrachte Behandlung");
  // Hinweis 3: echte Kalenderdaten (2026-02-30 → fehlende Angabe); Geburtsdatum darf Tag/Monat „00“ haben
  if (!istDatum(vo.issuedAt)) fehlend.push("Verordnungsdatum im Format JJJJ-MM-TT (gültiges Kalenderdatum)");
  if (!achtzehnterGeburtstag(patient.birthDate)) fehlend.push(FEHLT_GEBURTSDATUM);
  sortiert.forEach((z) => {
    if (!istDatum(z.date)) fehlend.push(`Behandlungsdatum für Position ${z.position} („${z.date}“) im Format JJJJ-MM-TT (gültiges Kalenderdatum)`);
  });
  // S1: Preise und Vollständigkeit des Snapshots; R2-7: Pauschale ist bei Snapshot Pflicht
  sortiert.forEach((z) => {
    if (z.priceCents === null || z.priceCents === undefined) fehlend.push(`Preis je Einheit für Position ${z.position} am ${z.date} (priceCents)`);
  });
  if (snapshot && snapshot.complete !== true) fehlend.push("Preis-Snapshot unvollständig (priceSnapshot.complete = false): fehlende Preise in der Vergütungsliste ergänzen und Snapshot neu bilden");
  if (snapshot && !(Number.isInteger(snapshot.flatFeeCents) && snapshot.flatFeeCents >= 0)) fehlend.push("Pauschale je Verordnung aus dem Preis-Snapshot (priceSnapshot.flatFeeCents)");

  if (befreiungszeitraeume(ergaenzung) === null) fehlend.push("Befreiungszeitraum gültig von–bis im Format JJJJ-MM-TT (von ≤ bis)");

  // S2: Positionsnummer für den Status der Praxis
  const nummern = sortiert.map((z) => {
    const n = ergaenzung.positionsnummer ? ergaenzung.positionsnummer(z.position) : z.position;
    if (!/^\d{5}$/.test(n ?? "")) fehlend.push(`Positionsnummer für ${z.position} (5-stellig, Status der Praxis ZL/KH/KB)`);
    return n ?? "";
  });

  const abweichungen: string[] = [];
  const gesehen = new Set<string>();
  sortiert.forEach((z, i) => {
    const k = `${nummern[i]}|${z.date}`;
    if (gesehen.has(k)) abweichungen.push(`Position ${z.position} am ${z.date} doppelt: gleiche Positionen am selben Tag sind im Preis-Snapshot zu einer Zeile zusammenzufassen (TA1 EHE Anzahl/Menge).`);
    gesehen.add(k);
  });

  const versicherter: Versicherter = {
    versichertennummer: patient.insuranceNumber ?? undefined,
    versichertenstatus: patient.insuranceStatus ?? undefined,
    nachname: patient.lastName,
    vorname: patient.firstName,
    geburtsdatum: patient.birthDate,
    strasse: patient.street ?? undefined,
    plz: patient.zip ?? undefined,
    ort: patient.city ?? undefined,
  };
  const verordnung: Verordnung = {
    betriebsstaettennummer: vo.doctorBsnr ?? undefined,
    lanr: vo.doctorLanr ?? undefined,
    verordnungsdatum: vo.issuedAt,
    diagnosegruppe: vo.diagnosisGroup,
    // nie still „03“ (Review-Runde 2, Buchhaltung): ohne Angabe bleibt das Feld leer und ist fehlende Angabe
    verordnungsart: ergaenzung.verordnungsart,
    therapieberichtAngefordert: vo.therapyReportRequested,
    hausbesuch: vo.homeVisit,
    leitsymptomatik: ergaenzung.leitsymptomatik ?? { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: false },
    leitsymptomatikText: ergaenzung.leitsymptomatikText,
    dringlicherBehandlungsbedarf: vo.urgent,
    heilmittelbereich: "2",
    therapiefrequenz: 0,
    diagnosen: [{ icd10: vo.icd10 ?? undefined, text: vo.icd10 ? undefined : ergaenzung.diagnosetext }],
  };
  const leistungen: Einzelleistung[] = sortiert.map((z, i) => ({
    positionsnummer: nummern[i],
    anzahl: z.units,
    einzelpreisCent: z.priceCents ?? 0,
    datum: z.date,
    gefahreneKilometer: z.kilometers,
    // null im Snapshot = Position ohne Zuzahlung laut Vergütungsliste; sonst Standard ja (D1)
    zuzahlungsfaehig: z.copayCents === null ? false : undefined,
  }));
  const z = ermittleZuzahlung(vo, patient, sortiert, snapshot, ergaenzung, fehlend, abweichungen);

  if (z.jePosition) leistungen.forEach((l, i) => (l.zuzahlungspflichtig = z.jePosition![i]));
  const fall: Abrechnungsfall = {
    belegnummer,
    beleginformation: vo.source === "everordnung" ? "0" : "1",
    eVoId: vo.source === "everordnung" ? vo.externalRef ?? undefined : undefined,
    versicherter,
    verordnung,
    zuzahlungskennzeichen: z.zk,
    pauschaleZuzahlung: z.pauschale,
    leistungen,
  };
  // Gegenrechnung: Snapshot-Beträge müssen der eigenen Berechnung (betraege.ts, TA1 EHE/BES) mit dem VKZ der
  // Gesamtrechnung entsprechen. Entfällt bei fehlenden Preisen und bei schon gefundenen Abweichungen.
  if (snapshot && z.gegenrechnung && sortiert.length && !abweichungen.length && sortiert.every((x) => x.priceCents !== null && x.priceCents !== undefined)) {
    const b = fallBetraege(fall, ergaenzung.zuzahlungProzent ?? 10, ergaenzung.zuzahlungPauschaleCent ?? ZUZAHLUNG_PAUSCHALE_CENT, z.gegenrechnung);
    sortiert.forEach((zeile, i) => {
      const soll = b.positionen[i].zuzahlungCent;
      const ist = zeile.copayCents ?? 0;
      if (soll !== ist) abweichungen.push(`Termin ${zeile.date}, Position ${zeile.position}: Zuzahlung im Preis-Snapshot ${ist} Cent, berechnet ${soll} Cent.`);
    });
    if (snapshot.flatFeeCents !== b.pauschaleZuzahlungCent) abweichungen.push(`Pauschale im Preis-Snapshot ${snapshot.flatFeeCents} Cent, berechnet ${b.pauschaleZuzahlungCent} Cent.`);
  }

  // S4/S5: Hinweise (sperren nicht), erst nach der Gegenrechnung, damit alle Abweichungen bekannt sind
  const hinweise: string[] = Array.isArray(snapshot?.notes) ? snapshot.notes.filter((n) => typeof n === "string") : [];
  const zeitraeume = befreiungszeitraeume(ergaenzung) ?? [];
  const enthaelt = (b: Befreiungszeitraum) => sortiert.some((x) => b.von <= x.date && x.date <= b.bis);
  // L1/Hinweis 5: „als zuzahlungspflichtig abgerechnet“ nur, wenn wirklich ein Termin zuzahlungspflichtig ist (laut
  // Alter/Befreiung und, mit Snapshot, mit Zuzahlung oder Pauschale) und keine Abweichung besteht
  const pflichtigerTermin =
    sortiert.some((x) => terminStatus(x.date, vo, patient, ergaenzung).status === "pflichtig") &&
    (!snapshot || sortiert.some((x) => (x.copayCents ?? 0) > 0) || (snapshot.flatFeeCents ?? 0) > 0);
  if (kreuzBestaetigt(vo, ergaenzung) && !zeitraeume.some(enthaelt) && pflichtigerTermin && !abweichungen.length) hinweise.push(HINWEIS_KREUZ);
  // L2/Hinweis 1: #111 meldet die Befreiung einer anderen Kasse schon in `notes` („… von einer anderen Krankenkasse
  // (IK …) als auf der Verordnung …“) → dann keinen zweiten, gleichbedeutenden Hinweis
  // IK vergleichen wie #111 (normalizeId): Leerzeichen zählen nicht
  const ikOhneLeerzeichen = (ik: string) => ik.replace(/\s+/g, "");
  const ikHinweisInNotes = hinweise.some((n) => n.includes("von einer anderen Krankenkasse"));
  for (const b of ikHinweisInNotes ? [] : zeitraeume) {
    if (enthaelt(b) && b.insurerIk && patient.insurerIk && ikOhneLeerzeichen(b.insurerIk) !== ikOhneLeerzeichen(patient.insurerIk)) {
      hinweise.push(`Befreiung ${b.von} bis ${b.bis} ist von einer anderen Krankenkasse (IK ${b.insurerIk}) als auf der Verordnung (IK ${patient.insurerIk}) – bitte prüfen.`);
    }
  }
  return { fall, fehlendeAngaben: [...new Set(fehlend)], abweichungen, hinweise: [...new Set(hinweise)] };
}
