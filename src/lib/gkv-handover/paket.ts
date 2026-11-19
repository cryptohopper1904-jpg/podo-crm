/**
 * Neutrales Übergabepaket eines Abrechnungslaufs an ein beliebiges Abrechnungszentrum (GKV Paket E). Reine Funktionen
 * ohne Datenbank: Behandlungen-CSV, JSON mit Schema-Version, Zusatzspalten der Verordnungen-CSV, Prüfsummen-Datei und
 * LIESMICH. Das Format ist in docs/GKV-ABRECHNUNGSZENTRUM.md beschrieben – Änderungen nur mit neuer Schema-Version.
 *
 * CSV: UTF-8 mit BOM, Semikolon, CRLF (deutsche Excel-Gewohnheit), Beträge „1234,56“, Datum JJJJ-MM-TT; Textzellen mit
 * = + - @ Tab/CR am Anfang werden entschärft (writeCsv → neutralizeCsvRows). JSON: Beträge in Cent (ganze Zahlen),
 * Datum JJJJ-MM-TT, Zeitpunkte ISO 8601 (UTC).
 */
import { createHash } from "node:crypto";
import { writeCsv } from "@/integrations/csv";

export const PAKET_SCHEMA = "podohero-abrechnung/1";

/**
 * Obergrenze je Übergabepaket (AppSec H1): Das ZIP entsteht beim ersten Export im Speicher (mit einem PDF je Verordnung).
 * 500 Verordnungen ≈ höchstens einige Dutzend MB; größere Läufe bitte aufteilen. Zusätzlich Grenze der fertigen Datei.
 */
export const HANDOVER_MAX_VERORDNUNGEN = 500;
export const HANDOVER_MAX_BYTES = 200 * 1024 * 1024;

/** Meldung, wenn ein Lauf zu groß für ein Übergabepaket ist; sonst null */
export function paketGrenze(anzahl: number): string | null {
  return anzahl > HANDOVER_MAX_VERORDNUNGEN
    ? `Der Abrechnungslauf hat ${anzahl} Verordnungen – ein Übergabepaket umfasst höchstens ${HANDOVER_MAX_VERORDNUNGEN}. Bitte künftig kleinere Läufe bilden und für diesen Lauf den Support kontaktieren.`
    : null;
}

export type Unterschrift = "geraet" | "papier" | "fehlt";

export type PaketLeistung = {
  datum: string;
  position: string;
  bezeichnung: string;
  einheiten: number;
  /** Preis je Einheit laut Preis-Snapshot (Anlage 2), null = kein Preis hinterlegt */
  einzelpreisCent: number | null;
  /** 10-%-Anteil dieser Zeile; null = Position ohne Zuzahlung laut Anlage 2 */
  zuzahlungCent: number | null;
  befreit: boolean;
  minderjaehrig: boolean;
  preisstand: string | null;
};

export type PaketVerordnung = {
  id: string;
  /** billed | correction_needed (Stand im Lauf) */
  status: string;
  /** Korrekturbezug aus Sicht dieses Laufs (wie Spalte „Korrektur“) */
  korrektur: string;
  person: { nummer: number | null; nachname: string; vorname: string | null; geburtsdatum: string | null; strasse: string | null; plz: string | null; ort: string | null };
  versicherung: { krankenkasse: string | null; kassenIk: string | null; versichertennummer: string | null; versichertenstatus: string | null };
  arzt: { name: string | null; lanr: string | null; bsnr: string | null };
  ausstellungsdatum: string;
  verordnungsart: string | null;
  besonderheit: { code: string; text: string } | null;
  genehmigung: { kennzeichen: string; datum: string } | null;
  diagnose: { gruppe: string; icd10: string | null; icd10Zweit: string | null; text: string | null; leitsymptomatik: string | null };
  heilmittel: string | null;
  hausbesuch: boolean;
  dringlich: boolean;
  unfallfolgen: boolean;
  bvg: boolean;
  therapieberichtAngefordert: boolean;
  einheitenVerordnet: number;
  positionen: { nummer: string | null; bezeichnung: string; einheiten: number }[];
  behandlungen: { datum: string; unterschrift: Unterschrift; nachgetragen: boolean }[];
  leistungen: PaketLeistung[];
  heilmittelkostenCent: number | null;
  zuzahlungCent: number | null;
  zuzahlungProzentCent: number | null;
  verordnungsblattgebuehrCent: number | null;
  zuzahlungsbefreit: string;
  zuzahlungsfreiAngekreuzt: boolean;
  zuzahlungErhaltenAm: string | null;
  abbruchvermerk: string | null;
  regelwerk: string | null;
  therapiebericht: { datum: string } | null;
  dokumente: { leistungsnachweis: string | null; therapiebericht: string | null };
};

export type PaketLauf = {
  id: string;
  erstellt: string;
  /** erster Übergabezeitpunkt, falls der Lauf schon vor dem Archiv übergeben war (sonst null = dieses Paket ist die Erstübergabe) */
  frueherUebergeben: string | null;
  abrechnungszentrum: string;
  notiz: string | null;
  anzahl: number;
  heilmittelkostenCent: number | null;
  zuzahlungCent: number;
};

export type PaketPraxis = { name: string; ik: string | null; leistungserbringergruppe: string | null; strasse: string | null; plz: string | null; ort: string | null };

export type PaketMeta = { erzeugt: string; praxis: PaketPraxis; lauf: PaketLauf };

/** Euro mit Komma (CSV) */
export const euro = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

/** Kassenanteil = Heilmittelkosten − Zuzahlung (nur mit Heilmittelkosten) */
export const kassenanteil = (vo: Pick<PaketVerordnung, "heilmittelkostenCent" | "zuzahlungCent">) =>
  vo.heilmittelkostenCent === null ? null : vo.heilmittelkostenCent - (vo.zuzahlungCent ?? 0);

/** Spalten, die die Verordnungen-CSV des Pakets hinter den Spalten des bisherigen Lauf-Exports (GKV_BATCH_HEADER) führt */
export const VERORDNUNGEN_ZUSATZ_KOPF = [
  "Status",
  "Personennummer",
  "Kassenanteil EUR",
  "Zuzahlung 10 % EUR",
  "Verordnungsblattgebühr EUR",
  "Therapiebericht Datum",
  "Behandlungen ohne Unterschrift",
  "Leistungsnachweis (Datei)",
  "Therapiebericht (Datei)",
] as const;

const STATUS_TEXT: Record<string, string> = { billed: "abgerechnet", correction_needed: "Korrektur nötig" };

export function verordnungZusatz(vo: PaketVerordnung): unknown[] {
  return [
    STATUS_TEXT[vo.status] ?? vo.status,
    vo.person.nummer ?? "",
    euro(kassenanteil(vo)),
    euro(vo.zuzahlungProzentCent),
    euro(vo.verordnungsblattgebuehrCent),
    vo.therapiebericht?.datum ?? "",
    vo.behandlungen.filter((b) => b.unterschrift === "fehlt").length,
    vo.dokumente.leistungsnachweis ?? "",
    vo.dokumente.therapiebericht ?? "",
  ];
}

export const BEHANDLUNGEN_KOPF = [
  "Lauf-ID",
  "Verordnung-ID",
  "Versichertennummer",
  "Ausstellungsdatum",
  "Datum",
  "Positionsnummer",
  "Bezeichnung",
  "Einheiten",
  "Einzelpreis EUR",
  "Betrag EUR",
  "Zuzahlung EUR",
  "Zuzahlung befreit",
  "Minderjährig",
  "Preisstand",
  "Unterschrift",
] as const;

const UNTERSCHRIFT_TEXT: Record<Unterschrift, string> = { geraet: "elektronisch", papier: "Papier", fehlt: "fehlt" };

/** Unterschrift eines Tages: fehlt eine, „fehlt“; sonst elektronisch vor Papier; nachgetragen markiert */
function unterschriftAm(vo: PaketVerordnung, datum: string): string {
  const tag = vo.behandlungen.filter((b) => b.datum === datum);
  if (!tag.length) return vo.therapiebericht?.datum === datum ? "– (Therapiebericht)" : "– (kein Behandlungseintrag)";
  if (tag.some((b) => b.unterschrift === "fehlt")) return "fehlt";
  const art = tag.some((b) => b.unterschrift === "geraet") ? "geraet" : "papier";
  return `${UNTERSCHRIFT_TEXT[art]}${tag.some((b) => b.nachgetragen) ? " (nachgetragen)" : ""}`;
}

/** Eine Zeile je Behandlungstag und Position (aus dem Preis-Snapshot der Abrechnung) */
export function behandlungenZeilen(laufId: string, vos: PaketVerordnung[]): unknown[][] {
  const rows: unknown[][] = [[...BEHANDLUNGEN_KOPF]];
  for (const vo of vos) {
    for (const l of vo.leistungen) {
      rows.push([
        laufId,
        vo.id,
        vo.versicherung.versichertennummer ?? "",
        vo.ausstellungsdatum,
        l.datum,
        l.position,
        l.bezeichnung,
        l.einheiten,
        euro(l.einzelpreisCent),
        l.einzelpreisCent === null ? "" : euro(l.einzelpreisCent * l.einheiten),
        l.zuzahlungCent === null ? "" : euro(l.zuzahlungCent),
        l.befreit ? "ja" : "nein",
        l.minderjaehrig ? "ja" : "nein",
        l.preisstand ?? "",
        unterschriftAm(vo, l.datum),
      ]);
    }
  }
  return rows;
}

/** CSV-Datei als Bytes: UTF-8 mit BOM, Semikolon, CRLF, Formel-Injection entschärft */
export const csvBytes = (rows: unknown[][]) => Buffer.from(writeCsv(rows), "utf8");

/** JSON des Pakets (gleicher Inhalt wie die CSV-Dateien, Beträge in Cent) */
export function paketJson(meta: PaketMeta, vos: PaketVerordnung[]) {
  const remedy = vos.reduce((s, v) => s + (v.heilmittelkostenCent ?? 0), 0);
  const copay = vos.reduce((s, v) => s + (v.zuzahlungCent ?? 0), 0);
  return {
    schema: PAKET_SCHEMA,
    erzeugt: meta.erzeugt,
    hinweis: "Kein Datensatz nach § 302 SGB V – neutrales Übergabeformat für ein Abrechnungszentrum (docs/GKV-ABRECHNUNGSZENTRUM.md).",
    praxis: meta.praxis,
    lauf: {
      id: meta.lauf.id,
      erstellt: meta.lauf.erstellt,
      frueher_uebergeben: meta.lauf.frueherUebergeben,
      abrechnungszentrum: meta.lauf.abrechnungszentrum,
      notiz: meta.lauf.notiz,
      anzahl_verordnungen: meta.lauf.anzahl,
      heilmittelkosten_cent: meta.lauf.heilmittelkostenCent,
      zuzahlung_cent: meta.lauf.zuzahlungCent,
      kassenanteil_cent: meta.lauf.heilmittelkostenCent === null ? null : meta.lauf.heilmittelkostenCent - meta.lauf.zuzahlungCent,
    },
    summen_verordnungen: { anzahl: vos.length, heilmittelkosten_cent: remedy, zuzahlung_cent: copay, kassenanteil_cent: remedy - copay },
    verordnungen: vos.map((v) => ({
      id: v.id,
      status: v.status,
      korrektur: v.korrektur || null,
      person: {
        nummer: v.person.nummer,
        nachname: v.person.nachname,
        vorname: v.person.vorname,
        geburtsdatum: v.person.geburtsdatum,
        strasse: v.person.strasse,
        plz: v.person.plz,
        ort: v.person.ort,
      },
      versicherung: { krankenkasse: v.versicherung.krankenkasse, kassen_ik: v.versicherung.kassenIk, versichertennummer: v.versicherung.versichertennummer, versichertenstatus: v.versicherung.versichertenstatus },
      arzt: v.arzt,
      ausstellungsdatum: v.ausstellungsdatum,
      verordnungsart: v.verordnungsart,
      verordnungsbesonderheit: v.besonderheit,
      genehmigung: v.genehmigung,
      diagnose: { gruppe: v.diagnose.gruppe, icd10: v.diagnose.icd10, icd10_zweit: v.diagnose.icd10Zweit, text: v.diagnose.text, leitsymptomatik: v.diagnose.leitsymptomatik },
      heilmittel: v.heilmittel,
      hausbesuch: v.hausbesuch,
      dringlich: v.dringlich,
      unfallfolgen: v.unfallfolgen,
      bvg: v.bvg,
      therapiebericht_angefordert: v.therapieberichtAngefordert,
      einheiten_verordnet: v.einheitenVerordnet,
      einheiten_erbracht: v.behandlungen.length,
      positionen: v.positionen,
      behandlungen: v.behandlungen,
      leistungen: v.leistungen.map((l) => ({
        datum: l.datum,
        position: l.position,
        bezeichnung: l.bezeichnung,
        einheiten: l.einheiten,
        einzelpreis_cent: l.einzelpreisCent,
        betrag_cent: l.einzelpreisCent === null ? null : l.einzelpreisCent * l.einheiten,
        zuzahlung_cent: l.zuzahlungCent,
        befreit: l.befreit,
        minderjaehrig: l.minderjaehrig,
        preisstand: l.preisstand,
      })),
      heilmittelkosten_cent: v.heilmittelkostenCent,
      zuzahlung_cent: v.zuzahlungCent,
      zuzahlung_10_prozent_cent: v.zuzahlungProzentCent,
      verordnungsblattgebuehr_cent: v.verordnungsblattgebuehrCent,
      kassenanteil_cent: kassenanteil(v),
      zuzahlungsbefreit: v.zuzahlungsbefreit,
      zuzahlungsfrei_angekreuzt: v.zuzahlungsfreiAngekreuzt,
      zuzahlung_erhalten_am: v.zuzahlungErhaltenAm,
      abbruchvermerk: v.abbruchvermerk,
      regelwerk: v.regelwerk,
      therapiebericht: v.therapiebericht,
      dokumente: v.dokumente,
    })),
  };
}

export const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Prüfsummen im Format von `sha256sum` (prüfbar mit `sha256sum -c PRUEFSUMMEN.sha256`), sortiert nach Pfad */
export function pruefsummenDatei(dateien: { name: string; bytes: Uint8Array }[]): string {
  return [...dateien]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => `${sha256Hex(d.bytes)}  ${d.name}\n`)
    .join("");
}

/** Dateiname im ZIP: nur unkritische Zeichen (keine Pfade aus Daten) */
export const sichererName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

export function liesMich(meta: PaketMeta, p: { verordnungen: number; leistungsnachweise: number; therapieberichte: number; fehlendeDokumente: string[] }): string {
  const z = [
    "PodoHero – Übergabepaket Abrechnungslauf (neutrales Format)",
    "============================================================",
    "",
    `Format:          ${PAKET_SCHEMA} (Beschreibung: docs/GKV-ABRECHNUNGSZENTRUM.md im PodoHero-Repository bzw. beim Support)`,
    `Praxis:          ${meta.praxis.name}${meta.praxis.ik ? ` (IK ${meta.praxis.ik})` : ""}`,
    `Abrechnungslauf: ${meta.lauf.id} vom ${meta.lauf.erstellt.slice(0, 10)}`,
    `Erzeugt:         ${meta.erzeugt}`,
    ...(meta.lauf.frueherUebergeben
      ? ["", `HINWEIS: Der Lauf wurde bereits am ${meta.lauf.frueherUebergeben.slice(0, 10)} (vor Einführung des Archivs) übergeben. Dieses Paket gibt den`, "Stand beim Archivieren wieder und kann in Behandlungstagen, Unterschriften und „Zuzahlung erhalten am“ von der damaligen", "Übergabe abweichen."]
      : []),
    "",
    "KEIN DATENSATZ NACH § 302 SGB V. Die Übermittlung an die Krankenkassen übernimmt das Abrechnungszentrum.",
    "Die Papierverordnungen (Muster 13) gehen wie vereinbart an das Abrechnungszentrum.",
    "",
    "INHALT",
    "------",
    "verordnungen.csv         Eine Zeile je Verordnung (UTF-8 mit BOM, Semikolon, Beträge 1234,56, Datum JJJJ-MM-TT).",
    "behandlungen.csv         Eine Zeile je Behandlungstag und Heilmittelposition (Preis-Snapshot der Abrechnung).",
    "abrechnungslauf.json     Gleicher Inhalt maschinenlesbar, Beträge in Cent, mit Schema-Version.",
    "begleitzettel.pdf        Deckblatt mit Summen und Liste der Verordnungen.",
    "dokumente/leistungsnachweis/   Leistungsnachweis je Verordnung (Behandlungen mit Unterschrift), PDF.",
    "dokumente/therapiebericht/     Therapiebericht (Position 78530), falls vorhanden, PDF.",
    "PRUEFSUMMEN.sha256       SHA-256 jeder Datei (prüfen: sha256sum -c PRUEFSUMMEN.sha256).",
    "",
    `Verordnungen: ${p.verordnungen} · Leistungsnachweise: ${p.leistungsnachweise} · Therapieberichte: ${p.therapieberichte}`,
    ...(p.fehlendeDokumente.length ? ["", "Nicht erzeugbar (bitte in PodoHero prüfen):", ...p.fehlendeDokumente.map((d) => `- ${d}`)] : []),
    "",
    "DATENSCHUTZ",
    "-----------",
    "Das Paket enthält Gesundheitsdaten (Art. 9 DSGVO) und unterliegt der Schweigepflicht (§ 203 StGB). Nur verschlüsselt",
    "und an das beauftragte Abrechnungszentrum (Auftragsverarbeitung) weitergeben.",
    "",
  ];
  return z.join("\r\n");
}
