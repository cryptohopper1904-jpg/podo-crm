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

export interface PodoHeroBehandlung {
  date: string;
  /** 5-stellige Heilmittelpositionsnummer */
  position: string;
  units: number;
  /** vereinbarter Preis je Einheit in Cent laut Preisliste der Kasse */
  priceCents: number;
  /** gefahrene Kilometer bei Wegegeld-Pauschale */
  kilometers?: number;
}

/** Angaben, die PodoHero heute nicht speichert, aber die TA1 verlangt */
export interface ErgaenzendeVerordnungsdaten {
  verordnungsart?: Verordnungsart;
  leitsymptomatik?: Leitsymptomatik;
  leitsymptomatikText?: string;
  zuzahlungskennzeichen?: Zuzahlungskennzeichen;
  diagnosetext?: string;
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
  }));
  const zzk: Zuzahlungskennzeichen = ergaenzung.zuzahlungskennzeichen ?? (vo.copaymentExempt ? "1" : "3");
  return {
    fall: {
      belegnummer,
      beleginformation: vo.source === "everordnung" ? "0" : "1",
      eVoId: vo.source === "everordnung" ? vo.externalRef ?? undefined : undefined,
      versicherter,
      verordnung,
      zuzahlungskennzeichen: zzk,
      leistungen,
    },
    fehlendeAngaben: fehlend,
  };
}
