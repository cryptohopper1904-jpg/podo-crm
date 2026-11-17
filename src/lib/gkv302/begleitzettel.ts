/**
 * Begleitzettel für Urbelege nach Anlage 4 (Version 2.0, anzuwenden ab 01.12.2006) – nur Inhalt/Struktur,
 * das PDF-Rendering folgt später.
 *
 * Pflichtinhalte je Gesamtrechnung (Anlage 4 „Inhalte“ Abs. 1): IK und Name der Krankenkasse, Name/Anschrift und
 * IK des Leistungserbringers bzw. der Abrechnungsstelle, Rechnungsnummer und -datum der Gesamtrechnung, Anzahl
 * der Urbelege. Abrechnungsstellen zusätzlich erste und letzte Belegnummer (Abs. 2).
 * Richtlinien § 4: Urbelege mit Rechnungsnummer (oben rechts) und Belegnummer kennzeichnen, nach Belegnummer
 * sortiert (Reihenfolge der Datensätze) mit dem Begleitzettel an die Belegannahmestelle senden.
 */
import { type Gkv302Fehler, Gkv302ValidierungsFehler } from "./fehler";
import type { NutzdateiErgebnis } from "./nutzdatei";
import type { Anschrift, Nutzdatendatei } from "./typen";

export interface Begleitzettel {
  titel: "Begleitzettel für Urbelege";
  kasse: { ik: string; name: string };
  /** Leistungserbringer bzw. Abrechnungsstelle */
  rechnungssteller: { ik: string; name: string; anschrift: Anschrift };
  /** Rechnungsnummer der Gesamtrechnung, wie im Datensatz (REC); bei Sammelrechnung beide Teile */
  rechnungsnummer: { sammel: string; einzel: string };
  rechnungsdatum: string;
  anzahlUrbelege: number;
  /** nur bei Abrechnungsstellen (Anlage 4 Abs. 2) */
  ersteBelegnummer?: string;
  letzteBelegnummer?: string;
  /** Belegnummern in Versandreihenfolge (Richtlinien § 4 Abs. 2), nur Fälle mit Papierbeleg */
  belegreihenfolge: string[];
  /** optional aus der Kostenträgerdatei (VKG 09): wohin die Urbelege gehen */
  belegannahmestelle?: { ik: string; name: string; anschrift?: Anschrift };
}

/**
 * Erstellt je Gesamtrechnung einen Begleitzettel. Bei Abrechnungsstellen (Absender-Art "A") kommen erste und
 * letzte Belegnummer hinzu. Fälle mit eVO-ID zählen standardmäßig nicht als Papierbeleg. Wirft
 * Gkv302ValidierungsFehler, wenn ein Pflichtinhalt (Name der Krankenkasse) fehlt.
 */
export function erstelleBegleitzettel(
  d: Nutzdatendatei,
  ergebnis: NutzdateiErgebnis,
  belegannahme?: (kasseIk: string) => Begleitzettel["belegannahmestelle"],
): Begleitzettel[] {
  const zettel: Begleitzettel[] = [];
  const fehler: Gkv302Fehler[] = [];
  d.leistungserbringer.forEach((le, i) => {
    le.kostentraeger.forEach((kt, j) => {
      kt.rechnungen.forEach((r, k) => {
        const pfad = `leistungserbringer[${i}].kostentraeger[${j}].rechnungen[${k}]`;
        // Zuordnung über Leistungserbringer-, Kostenträger- und Kassen-IK plus Rechnungsnummer (nicht über die Reihenfolge)
        const sammelNr = kt.sammelrechnung ? kt.sammelrechnung.rechnungsnummer : r.rechnungsnummer;
        const einzelNr = kt.sammelrechnung ? r.rechnungsnummer : "0";
        const g = ergebnis.gesamtrechnungen.find(
          (x) => x.leistungserbringerIk === le.praxis.ik && x.kostentraegerIk === kt.kostentraegerIk && x.kasseIk === r.kasseIk && x.sammelRechnungsnummer === sammelNr && x.einzelRechnungsnummer === einzelNr,
        );
        if (!g) {
          fehler.push({ art: "kombination", pfad, meldung: `Gesamtrechnung ${sammelNr}:${einzelNr} für Kassen-IK ${r.kasseIk} ist im Ergebnis der Nutzdatei nicht enthalten.` });
          return;
        }
        // Anlage 4 V2.0 „Inhalte“ Abs. 1, S. 2: Name der Krankenkasse ist Pflichtinhalt
        if (!r.kasseName?.trim()) {
          fehler.push({ art: "pflichtfeld", pfad: `${pfad}.kasseName`, meldung: `Name der Krankenkasse (IK ${r.kasseIk}) fehlt; er ist Pflichtinhalt des Begleitzettels (Anlage 4).` });
          return;
        }
        const papier = r.faelle.filter((f) => (f.anzahlUrbelege ?? (f.eVoId ? 0 : 1)) > 0);
        const anzahl = r.faelle.reduce((s, f) => s + (f.anzahlUrbelege ?? (f.eVoId ? 0 : 1)), 0);
        const istStelle = d.absender.art === "A";
        zettel.push({
          titel: "Begleitzettel für Urbelege",
          kasse: { ik: r.kasseIk, name: r.kasseName },
          rechnungssteller: istStelle
            ? { ik: d.absender.ik, name: d.absender.name ?? "", anschrift: d.absender.anschrift ?? le.praxis.anschrift }
            : { ik: le.praxis.ik, name: le.praxis.name, anschrift: le.praxis.anschrift },
          rechnungsnummer: { sammel: g.sammelRechnungsnummer, einzel: g.einzelRechnungsnummer },
          rechnungsdatum: r.rechnungsdatum,
          anzahlUrbelege: anzahl,
          ersteBelegnummer: istStelle ? papier[0]?.belegnummer : undefined,
          letzteBelegnummer: istStelle ? papier[papier.length - 1]?.belegnummer : undefined,
          belegreihenfolge: papier.map((f) => f.belegnummer),
          belegannahmestelle: belegannahme?.(r.kasseIk),
        });
      });
    });
  });
  if (fehler.length) throw new Gkv302ValidierungsFehler(fehler);
  return zettel;
}
