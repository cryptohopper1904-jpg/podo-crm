/**
 * Begleitzettel für Urbelege (Anlage 4 V2.0) als PDF – eine Seite je Gesamtrechnung mit Papierbelegen.
 * Inhalt kommt unverändert aus `erstelleBegleitzettel`; hier nur das Layout. Im Testpaket deutlich als TEST markiert.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Begleitzettel } from "./begleitzettel";

const de = (iso: string) => iso.split("-").reverse().join(".");

/** WinAnsi (Standardschrift) kennt nicht jedes Zeichen – Unbekanntes wird ersetzt statt abzubrechen */
function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff€–—„“”‚‘’…]/g, "?");
}

export async function begleitzettelPdf(zettel: Begleitzettel[], opts: { test: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.test ? "Begleitzettel (TEST)" : "Begleitzettel für Urbelege");
  doc.setProducer("PodoHero");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const z of zettel) {
    const page = doc.addPage([595.28, 841.89]);
    let y = 790;
    const zeile = (text: string, o: { fett?: boolean; groesse?: number; farbe?: [number, number, number] } = {}) => {
      page.drawText(winAnsi(text), { x: 56, y, size: o.groesse ?? 11, font: o.fett ? bold : font, color: rgb(...(o.farbe ?? [0, 0, 0])) });
      y -= (o.groesse ?? 11) + 7;
    };
    if (opts.test) {
      zeile("TEST – NICHT VERSENDEN", { fett: true, groesse: 16, farbe: [0.75, 0.1, 0.1] });
      zeile("Unverschlüsselte Testdatei ohne ITSG-Zertifikat. Nicht an eine Datenannahmestelle oder Belegannahmestelle schicken.", { groesse: 9, farbe: [0.75, 0.1, 0.1] });
      y -= 8;
    }
    zeile(z.titel, { fett: true, groesse: 15 });
    y -= 6;
    zeile("Krankenkasse", { fett: true });
    zeile(`${z.kasse.name} (IK ${z.kasse.ik})`);
    y -= 4;
    zeile("Rechnungssteller", { fett: true });
    zeile(`${z.rechnungssteller.name} (IK ${z.rechnungssteller.ik})`);
    zeile(`${z.rechnungssteller.anschrift.strasse}, ${z.rechnungssteller.anschrift.plz} ${z.rechnungssteller.anschrift.ort}`);
    y -= 4;
    zeile("Gesamtrechnung", { fett: true });
    zeile(`Rechnungsnummer: ${z.rechnungsnummer.einzel === "0" ? z.rechnungsnummer.sammel : `${z.rechnungsnummer.sammel}:${z.rechnungsnummer.einzel}`}`);
    zeile(`Rechnungsdatum: ${de(z.rechnungsdatum)}`);
    zeile(`Anzahl der Urbelege: ${z.anzahlUrbelege}`);
    if (z.ersteBelegnummer) zeile(`Erste / letzte Belegnummer: ${z.ersteBelegnummer} / ${z.letzteBelegnummer}`);
    if (z.belegannahmestelle) {
      y -= 4;
      zeile("Belegannahmestelle (laut Kostenträgerdatei)", { fett: true });
      zeile(`${z.belegannahmestelle.name} (IK ${z.belegannahmestelle.ik})`);
      if (z.belegannahmestelle.anschrift) zeile(`${z.belegannahmestelle.anschrift.strasse}, ${z.belegannahmestelle.anschrift.plz} ${z.belegannahmestelle.anschrift.ort}`);
    }
    y -= 4;
    zeile("Reihenfolge der Belege (Belegnummer)", { fett: true });
    const nummern = z.belegreihenfolge.join(", ") || "–";
    for (let i = 0; i < nummern.length && y > 60; i += 90) zeile(nummern.slice(i, i + 90), { groesse: 10 });
  }
  return doc.save();
}
