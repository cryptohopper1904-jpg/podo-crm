/**
 * Adapter-Schnittstelle: PodoHero-Daten → Datenmodell § 302. Nur Typen und eine reine Abbildungsfunktion,
 * keine DB-Zugriffe und keine Schemaänderung in diesem Paket.
 *
 * Die Quellfelder spiegeln den heutigen Stand von `prescriptions`/`patients` (src/db/schema.ts). Was die TA1
 * zusätzlich verlangt und dort noch fehlt, meldet `bildeAbrechnungsfall` als `fehlendeAngaben`; diese Felder
 * müssen vor dem echten Einsatz im Schema ergänzt werden (siehe docs/GKV-302.md, „Offene Punkte“).
 */
import type { Abrechnungsfall, Einzelleistung, Leitsymptomatik, Verordnung, Versicherter } from "./typen";
import type { Verordnungsart, Zuzahlungskennzeichen } from "./schluessel";
import { fallBetraege } from "./betraege";

/** Pauschale je Verordnung (TA1 V21 5.5.3.3 BES, S. 73); gleicher Wert wie ZUZAHLUNG_PAUSCHALE_CENT in nutzdatei.ts */
const ZUZAHLUNG_PAUSCHALE_CENT = 1000;

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
 * Eine Einzelleistung je Termin (Datum) und Position, wie sie der Preis-Snapshot der Verordnung liefert
 * (PR #111: `priceSnapshot.lines[]`). Der Adapter fasst nichts zusammen und erfindet keine Beträge: gleiche
 * Positionen am selben Tag müssen schon im Snapshot eine Zeile sein (TA1 V21 5.5.3.3 EHE Anzahl/Menge, S. 66).
 */
export interface PodoHeroBehandlung {
  date: string;
  /** 5-stellige Heilmittelpositionsnummer */
  position: string;
  units: number;
  /** vereinbarter Preis je Einheit in Cent laut Preisliste der Kasse */
  priceCents: number;
  /** gefahrene Kilometer bei Wegegeld-Pauschale */
  kilometers?: number;
  /**
   * Zuzahlung dieser Zeile in Cent aus dem Preis-Snapshot (`priceSnapshot.lines[].copayCents`):
   * `null` = Position ohne Zuzahlung laut Vergütungsliste (Spalte „-“ bzw. leer), `0` = an diesem Termin keine
   * Zuzahlung (unter 18 oder befreit), `> 0` = Zuzahlung; `undefined` = kein Snapshot vorhanden.
   */
  copayCents?: number | null;
}

/** Angaben, die PodoHero heute nicht speichert, aber die TA1 verlangt */
export interface ErgaenzendeVerordnungsdaten {
  verordnungsart?: Verordnungsart;
  leitsymptomatik?: Leitsymptomatik;
  leitsymptomatikText?: string;
  /** nur für Sonderfälle (z. B. „2“ bei VKZ 03); sonst wird das Kennzeichen abgeleitet, nie aus dem Kreuz „gebührenfrei“ */
  zuzahlungskennzeichen?: Zuzahlungskennzeichen;
  diagnosetext?: string;
  /** Gültigkeit der Zuzahlungsbefreiung laut Bescheinigung der Kasse ("JJJJ-MM-TT", beide Grenzen einschließlich) */
  befreiungVon?: string;
  befreiungBis?: string;
  /** Pauschale je Verordnung aus dem Preis-Snapshot (`priceSnapshot.flatFeeCents`) */
  pauschaleCents?: number;
  /** Zuzahlungsprozentsatz für die Gegenrechnung (Standard 10, § 61 Satz 3 SGB V) */
  zuzahlungProzent?: number;
}

/**
 * Frühester und spätester möglicher Tag des 18. Geburtstags. Unbekannte Tage/Monate („JJJJ-MM-00“, „JJJJ-00-00“,
 * TA1 V21 NAD Geburtsdatum) ergeben einen Zeitraum statt eines Tages.
 */
function achtzehnterGeburtstag(geburtsdatum: string): { fruehestens: string; spaetestens: string } | null {
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

/**
 * Erwarteter Zuzahlungsstatus je Termin aus Alter und Befreiungszeitraum:
 * - unter 18 am Behandlungstag: keine gesetzliche Zuzahlung (§ 32 Abs. 2 Satz 1 SGB V: Zuzahlung erst nach
 *   Vollendung des 18. Lebensjahres) → frei;
 * - Befreiung (§ 62 SGB V) mit Gültigkeitszeitraum, der den Termin enthält → frei;
 * - Kreuz „gebührenfrei“ ohne Zeitraum oder unklares Geburtsdatum → unklar (wird nie still als „3“ gewertet).
 */
function terminStatus(datum: string, vo: PodoHeroVerordnung, patient: PodoHeroPatient, e: ErgaenzendeVerordnungsdaten): { status: TerminStatus; grund?: "alter" | "befreiung" } {
  const geb18 = achtzehnterGeburtstag(patient.birthDate);
  if (!geb18) return { status: "unklar" };
  if (datum < geb18.fruehestens) return { status: "frei", grund: "alter" };
  if (datum < geb18.spaetestens) return { status: "unklar", grund: "alter" };
  if (e.befreiungVon && e.befreiungBis) {
    return e.befreiungVon <= datum && datum <= e.befreiungBis ? { status: "frei", grund: "befreiung" } : { status: "pflichtig" };
  }
  if (vo.copaymentExempt || e.befreiungVon || e.befreiungBis) return { status: "unklar", grund: "befreiung" };
  return { status: "pflichtig" };
}

/** Kennzeichen aus einer zeitlich sortierten Folge von Status (Anlage 3 V21 8.1.3, S. 10) */
function kennzeichenAusFolge(folge: ("pflichtig" | "frei")[], freiGrund: "alter" | "befreiung" | undefined): Zuzahlungskennzeichen | null {
  if (folge.every((x) => x === "pflichtig")) return "3";
  if (folge.every((x) => x === "frei")) return freiGrund === "alter" ? "0" : "1";
  const wechsel = folge.findIndex((x, i) => i > 0 && x !== folge[i - 1]);
  const einWechsel = folge.slice(wechsel).every((x) => x === folge[wechsel]);
  if (!einWechsel) return null;
  return folge[0] === "pflichtig" ? "4" : "5";
}

/**
 * Zuzahlungskennzeichen (Anlage 3 V21 8.1.3). Mit Preis-Snapshot (alle Zeilen mit `copayCents`) wird das
 * Kennzeichen aus den Zuzahlungen je Einzelleistung abgeleitet und gegen Alter/Befreiung geprüft; ohne Snapshot
 * nur aus Alter und Befreiungszeitraum. Ändert sich der Status im Behandlungszeitraum und lässt er sich nicht
 * belegen, entsteht eine fehlende Angabe statt eines stillen „3“.
 */
function ermittleZuzahlung(
  vo: PodoHeroVerordnung,
  patient: PodoHeroPatient,
  behandlungen: PodoHeroBehandlung[],
  e: ErgaenzendeVerordnungsdaten,
  fehlend: string[],
  abweichungen: string[],
): { zk: Zuzahlungskennzeichen; jePosition?: boolean[]; pauschale?: boolean } {
  if (e.zuzahlungskennzeichen) return { zk: e.zuzahlungskennzeichen };
  if (!behandlungen.length) return { zk: "3" };
  const sortiert = behandlungen.map((b, i) => ({ b, i })).sort((x, y) => (x.b.date < y.b.date ? -1 : x.b.date > y.b.date ? 1 : 0));
  const erwartet = sortiert.map(({ b }) => terminStatus(b.date, vo, patient, e));
  const freiGrund = erwartet.find((x) => x.status === "frei")?.grund;
  const mitSnapshot = behandlungen.every((b) => b.copayCents !== undefined);

  if (!mitSnapshot) {
    if (erwartet.some((x) => x.status === "unklar")) {
      if (erwartet.some((x) => x.grund === "alter" && x.status === "unklar")) fehlend.push("18. Geburtstag fällt in den Behandlungszeitraum: Zuzahlungskennzeichen (5) und Zuzahlung je Termin manuell festlegen");
      else if (!patient.birthDate || !achtzehnterGeburtstag(patient.birthDate)) fehlend.push("Geburtsdatum im Format JJJJ-MM-TT (für die Prüfung „unter 18“)");
      else fehlend.push("Zeitraum der Zuzahlungsbefreiung (gültig von–bis laut Befreiungsbescheinigung)");
      return { zk: vo.copaymentExempt ? "1" : "3" };
    }
    const zk = kennzeichenAusFolge(erwartet.map((x) => x.status as "pflichtig" | "frei"), freiGrund);
    if ((zk === "5" || zk === null) && freiGrund === "alter") {
      fehlend.push("18. Geburtstag fällt in den Behandlungszeitraum: Zuzahlungskennzeichen (5) und Zuzahlung je Termin manuell festlegen");
      return { zk: "3" };
    }
    if (zk === "4" || zk === "5" || zk === null) {
      fehlend.push("Befreiung beginnt oder endet im Behandlungszeitraum: Zuzahlungskennzeichen (4 oder 5) und Zuzahlung je Termin manuell festlegen");
      return { zk: "3" };
    }
    if (zk === "3") fehlend.push("Zuzahlung je Einzelleistung aus dem Preis-Snapshot (priceSnapshot.lines[].copayCents)");
    return { zk };
  }

  // Snapshot: Zuzahlung je Einzelleistung ist die Quelle (D2); Positionen mit null zählen nicht
  const relevant = sortiert.filter(({ b }) => b.copayCents !== null);
  const pauschale = (e.pauschaleCents ?? 0) > 0;
  let zk: Zuzahlungskennzeichen | null;
  if (!relevant.length) {
    // nur zuzahlungsfreie Positionen: Kennzeichen hängt allein an der Pauschale
    zk = pauschale ? "3" : erwartet.every((x) => x.status === "frei") ? (freiGrund === "alter" ? "0" : "1") : null;
  } else {
    zk = kennzeichenAusFolge(relevant.map(({ b }) => ((b.copayCents ?? 0) > 0 ? "pflichtig" : "frei")), freiGrund);
  }
  if (zk === null) {
    abweichungen.push("Zuzahlung je Termin im Preis-Snapshot ergibt kein eindeutiges Zuzahlungskennzeichen (mehrfacher Wechsel oder Befreiung/Alter nicht belegt).");
    return { zk: "3" };
  }
  // Gegenprüfung mit Alter/Befreiung je Termin
  sortiert.forEach(({ b }, k) => {
    if (b.copayCents === null) return;
    const ist = (b.copayCents ?? 0) > 0 ? "pflichtig" : "frei";
    const soll = erwartet[k].status;
    if (soll !== "unklar" && soll !== ist) abweichungen.push(`Termin ${b.date}, Position ${b.position}: Preis-Snapshot ${ist === "pflichtig" ? "mit" : "ohne"} Zuzahlung, nach Alter/Befreiung aber zuzahlungs${soll === "pflichtig" ? "pflichtig" : "frei"}.`);
    if (soll === "unklar" && ist === "frei") abweichungen.push(`Termin ${b.date}, Position ${b.position}: Preis-Snapshot ohne Zuzahlung, aber weder „unter 18“ noch ein Befreiungszeitraum ist belegt.`);
  });
  if (zk === "4" || zk === "5") {
    return { zk, jePosition: behandlungen.map((b) => (b.copayCents ?? 0) > 0), pauschale };
  }
  return { zk };
}

/** Quelle, die der spätere Server-Code implementiert (DB-Zugriff je Praxis, Rechte, Mandantentrennung) */
export interface PodoHeroAbrechnungsquelle {
  /** abrechnungsreife Verordnungen eines Zeitraums (Status billing_ready) */
  ladeAbrechnungsreife(von: string, bis: string): Promise<{ verordnung: PodoHeroVerordnung; patient: PodoHeroPatient; behandlungen: PodoHeroBehandlung[]; ergaenzung: ErgaenzendeVerordnungsdaten }[]>;
}

export interface AbbildungsErgebnis {
  fall: Abrechnungsfall;
  /** Pflichtangaben, die fehlen; solange nicht leer, darf der Fall nicht abgerechnet werden */
  fehlendeAngaben: string[];
  /**
   * Widersprüche zwischen dem Preis-Snapshot (Zuzahlung je Einzelleistung, Pauschale) und der eigenen Rechnung
   * bzw. Alter/Befreiung; solange nicht leer, darf der Fall ebenfalls nicht abgerechnet werden.
   */
  abweichungen: string[];
}

/** Bildet einen Fall ab. Die Belegnummer vergibt der Aufrufer (eindeutig je Gesamtrechnung, Sortierreihenfolge). */
export function bildeAbrechnungsfall(
  belegnummer: string,
  vo: PodoHeroVerordnung,
  patient: PodoHeroPatient,
  behandlungen: PodoHeroBehandlung[],
  ergaenzung: ErgaenzendeVerordnungsdaten,
): AbbildungsErgebnis {
  const fehlend: string[] = [];
  if (!ergaenzung.verordnungsart) fehlend.push("Kennzeichen Verordnungsart (Anlage 3, 8.1.12)");
  if (!ergaenzung.leitsymptomatik) fehlend.push("Leitsymptomatik (a/b/c/patientenindividuell)");
  if (!patient.insuranceStatus) fehlend.push("Versichertenstatus von der Verordnung");
  if (!patient.insurerIk) fehlend.push("IK der Krankenkasse von der Verordnung");
  if (!vo.icd10 && !ergaenzung.diagnosetext) fehlend.push("ICD-10-Code oder Diagnosetext");
  if (!behandlungen.length) fehlend.push("mindestens eine erbrachte Behandlung");
  const abweichungen: string[] = [];
  const gesehen = new Set<string>();
  behandlungen.forEach((b) => {
    const k = `${b.position}|${b.date}`;
    if (gesehen.has(k)) abweichungen.push(`Position ${b.position} am ${b.date} doppelt: gleiche Positionen am selben Tag sind im Preis-Snapshot zu einer Zeile zusammenzufassen (TA1 EHE Anzahl/Menge).`);
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
    verordnungsart: ergaenzung.verordnungsart ?? "03",
    therapieberichtAngefordert: vo.therapyReportRequested,
    hausbesuch: vo.homeVisit,
    leitsymptomatik: ergaenzung.leitsymptomatik ?? { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: false },
    leitsymptomatikText: ergaenzung.leitsymptomatikText,
    dringlicherBehandlungsbedarf: vo.urgent,
    heilmittelbereich: "2",
    therapiefrequenz: 0,
    diagnosen: [{ icd10: vo.icd10 ?? undefined, text: vo.icd10 ? undefined : ergaenzung.diagnosetext }],
  };
  const leistungen: Einzelleistung[] = behandlungen.map((b) => ({
    positionsnummer: b.position,
    anzahl: b.units,
    einzelpreisCent: b.priceCents,
    datum: b.date,
    gefahreneKilometer: b.kilometers,
    // null im Snapshot = Position ohne Zuzahlung laut Vergütungsliste; sonst Standard ja (D1)
    zuzahlungsfaehig: b.copayCents === null ? false : undefined,
  }));
  const z = ermittleZuzahlung(vo, patient, behandlungen, ergaenzung, fehlend, abweichungen);
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
  // Gegenrechnung: Snapshot-Beträge müssen der eigenen Berechnung (betraege.ts, TA1 EHE/BES) entsprechen
  if (behandlungen.length && behandlungen.every((b) => b.copayCents !== undefined) && !abweichungen.length) {
    const b = fallBetraege(fall, ergaenzung.zuzahlungProzent ?? 10, ZUZAHLUNG_PAUSCHALE_CENT);
    behandlungen.forEach((zeile, i) => {
      const soll = b.positionen[i].zuzahlungCent;
      const ist = zeile.copayCents ?? 0;
      if (soll !== ist) abweichungen.push(`Termin ${zeile.date}, Position ${zeile.position}: Zuzahlung im Preis-Snapshot ${ist} Cent, berechnet ${soll} Cent.`);
    });
    if (ergaenzung.pauschaleCents !== undefined && ergaenzung.pauschaleCents !== b.pauschaleZuzahlungCent) {
      abweichungen.push(`Pauschale im Preis-Snapshot ${ergaenzung.pauschaleCents} Cent, berechnet ${b.pauschaleZuzahlungCent} Cent.`);
    }
  }
  return { fall, fehlendeAngaben: fehlend, abweichungen };
}
