/**
 * Begleitzettel/Deckblatt des neutralen Übergabepakets (GKV Paket E): Praxis, Lauf, Summen und Liste der Verordnungen
 * (Name, Personennummer, Versichertennummer, Kassen-IK, Ausstellungsdatum, Heilmittelkosten, Zuzahlung, Kassenanteil).
 * Keine Diagnosen auf dem Deckblatt (Datenminimierung – die stehen in CSV/JSON).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { euro, kassenanteil, PAKET_SCHEMA, type PaketMeta, type PaketVerordnung } from "./paket";

const de = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "–");

/** WinAnsi (Standardschrift) kennt nicht jedes Zeichen – Unbekanntes wird ersetzt statt abzubrechen */
function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff€–—„“”‚‘’…]/g, "?");
}

function kuerzen(font: PDFFont, text: string, size: number, max: number): string {
  let t = winAnsi(text);
  if (font.widthOfTextAtSize(t, size) <= max) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
  return `${t}…`;
}

export async function deckblattPdf(meta: PaketMeta, vos: PaketVerordnung[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Begleitzettel Abrechnungslauf ${meta.lauf.erstellt.slice(0, 10)}`);
  doc.setProducer("PodoHero");
  doc.setCreationDate(new Date(meta.erzeugt));
  doc.setModificationDate(new Date(meta.erzeugt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 841.89; // A4 quer
  const H = 595.28;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - 50;
  const zeile = (text: string, o: { fett?: boolean; groesse?: number; x?: number } = {}) => {
    page.drawText(winAnsi(text), { x: o.x ?? 40, y, size: o.groesse ?? 10, font: o.fett ? bold : font, color: rgb(0, 0, 0) });
    y -= (o.groesse ?? 10) + 6;
  };
  const remedy = vos.reduce((s, v) => s + (v.heilmittelkostenCent ?? 0), 0);
  const copay = vos.reduce((s, v) => s + (v.zuzahlungCent ?? 0), 0);
  zeile("Begleitzettel – Übergabe Abrechnungslauf an das Abrechnungszentrum", { fett: true, groesse: 15 });
  zeile(`Neutrales Format ${PAKET_SCHEMA} – kein Datensatz nach § 302 SGB V`, { groesse: 9 });
  y -= 4;
  zeile(`Praxis: ${meta.praxis.name}${meta.praxis.ik ? ` · IK ${meta.praxis.ik}` : ""}${meta.praxis.leistungserbringergruppe ? ` · Leistungserbringergruppe ${meta.praxis.leistungserbringergruppe}` : ""}`);
  zeile(`Anschrift: ${[meta.praxis.strasse, [meta.praxis.plz, meta.praxis.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "–"}`);
  zeile(`Abrechnungslauf: ${meta.lauf.id} · erstellt ${de(meta.lauf.erstellt)} · Abrechnungszentrum: ${meta.lauf.abrechnungszentrum}${meta.lauf.notiz ? ` · ${meta.lauf.notiz}` : ""}`);
  zeile(`Paket erzeugt: ${de(meta.erzeugt)}${meta.lauf.frueherUebergeben ? ` · Lauf bereits am ${de(meta.lauf.frueherUebergeben)} übergeben (Stand beim Archivieren)` : ""}`);
  y -= 4;
  zeile(`Verordnungen: ${vos.length} · Heilmittelkosten: ${euro(remedy)} € · Zuzahlungen: ${euro(copay)} € · Kassenanteil: ${euro(remedy - copay)} €`, { fett: true, groesse: 11 });
  y -= 6;
  const spalten: { t: string; w: number; rechts?: boolean }[] = [
    { t: "Nr.", w: 28 },
    { t: "Person (Nr.)", w: 190 },
    { t: "Versichertennr.", w: 95 },
    { t: "Kassen-IK", w: 72 },
    { t: "VO vom", w: 62 },
    { t: "Status", w: 80 },
    { t: "Heilmittel €", w: 75, rechts: true },
    { t: "Zuzahlung €", w: 70, rechts: true },
    { t: "Kassenanteil €", w: 80, rechts: true },
  ];
  const kopf = () => {
    let x = 40;
    for (const s of spalten) {
      page.drawText(s.t, { x: s.rechts ? x + s.w - bold.widthOfTextAtSize(s.t, 9) - 4 : x, y, size: 9, font: bold });
      x += s.w;
    }
    y -= 4;
    page.drawLine({ start: { x: 40, y }, end: { x: W - 40, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 12;
  };
  kopf();
  vos.forEach((v, i) => {
    if (y < 50) {
      page = doc.addPage([W, H]);
      y = H - 50;
      kopf();
    }
    const werte = [
      String(i + 1),
      `${[v.person.vorname, v.person.nachname].filter(Boolean).join(" ")}${v.person.nummer !== null ? ` (#${v.person.nummer})` : ""}`,
      v.versicherung.versichertennummer ?? "–",
      v.versicherung.kassenIk ?? "–",
      de(v.ausstellungsdatum),
      v.status === "correction_needed" ? "Korrektur nötig" : "abgerechnet",
      euro(v.heilmittelkostenCent) || "–",
      euro(v.zuzahlungCent) || "0,00",
      euro(kassenanteil(v)) || "–",
    ];
    let x = 40;
    werte.forEach((w, j) => {
      const s = spalten[j];
      const t = kuerzen(font, w, 9, s.w - 6);
      page.drawText(t, { x: s.rechts ? x + s.w - font.widthOfTextAtSize(t, 9) - 4 : x, y, size: 9, font });
      x += s.w;
    });
    y -= 13;
  });
  const seiten = doc.getPages();
  seiten.forEach((p, i) => p.drawText(`Seite ${i + 1} von ${seiten.length}`, { x: W - 120, y: 25, size: 8, font }));
  return doc.save();
}
