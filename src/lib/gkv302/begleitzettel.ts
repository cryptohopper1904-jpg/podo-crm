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
 * letzte Belegnummer hinzu. Fälle mit eVO-ID zählen standardmäßig nicht als Papierbeleg.
 */
export function erstelleBegleitzettel(
  d: Nutzdatendatei,
  ergebnis: NutzdateiErgebnis,
  belegannahme?: (kasseIk: string) => Begleitzettel["belegannahmestelle"],
): Begleitzettel[] {
  const zettel: Begleitzettel[] = [];
  let index = 0;
  for (const le of d.leistungserbringer) {
    for (const kt of le.kostentraeger) {
      for (const r of kt.rechnungen) {
        const g = ergebnis.gesamtrechnungen[index++];
        const papier = r.faelle.filter((f) => (f.anzahlUrbelege ?? (f.eVoId ? 0 : 1)) > 0);
        const anzahl = r.faelle.reduce((s, f) => s + (f.anzahlUrbelege ?? (f.eVoId ? 0 : 1)), 0);
        const istStelle = d.absender.art === "A";
        zettel.push({
          titel: "Begleitzettel für Urbelege",
          kasse: { ik: r.kasseIk, name: r.kasseName ?? "" },
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
      }
    }
  }
  return zettel;
}
