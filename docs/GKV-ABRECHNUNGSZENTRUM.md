# Neutrales Übergabeformat für Abrechnungszentren (GKV Paket E)

Stand: 19.11.2026 · Format `podohero-abrechnung/1` (Übergabe) und `podohero-rueckmeldung/1` (Rückmeldung)

PodoHero bindet bewusst **kein festes Abrechnungszentrum** an (weder DMRZ, opta data noch Noventi). Stattdessen erzeugt
PodoHero je Abrechnungslauf ein **neutrales Übergabepaket**, das jedes Abrechnungszentrum übernehmen kann, und liest eine
**Rückmeldung** (Auszahlung, Absetzungen) in einem ebenso neutralen Format wieder ein. Dieses Dokument beschreibt beide
Formate vollständig (Felder, Typen, Beispiele), damit ein Abrechnungszentrum einen Import bzw. Export dafür bauen kann.

**Kein Datensatz nach § 302 SGB V.** Die Datenübermittlung an die Krankenkassen bleibt Aufgabe des Abrechnungszentrums.
Die Papierverordnungen (Muster 13) gehen wie vereinbart an das Abrechnungszentrum. Die Direktabrechnung nach § 302 ist ein
eigenes Vorhaben (docs/GKV-302.md).

Code: `src/lib/gkv-handover/paket.ts` (Inhalte), `src/lib/gkv-handover/deckblatt-pdf.ts` (Begleitzettel),
`src/lib/gkv-handover/rueckmeldung.ts` (Prüfung der Rückmeldung), `src/server/gkv-handover.ts` (Archiv, Zuordnung),
Migration `drizzle/0068_gkv_paket_e.sql`.

## 1. Bedienung in PodoHero

- **Verordnungen → GKV-Abrechnung → Abrechnungslauf → „Öffnen“** (`/verordnungen/abrechnung/<lauf>`), Recht
  **Rechnungen schreiben + medizinisch lesen** (`invoices.write` + `medical.read`), nur mit Kassenabrechnung
  (`gkvGuard("gkvBilling")`).
- **Übergabepaket herunterladen** (`/api/export/gkv-batch/<lauf>/paket`): Der **erste** Download erzeugt das Paket, legt es
  verschlüsselt in der Dateiablage ab (AES-256-GCM je Praxis, `storeEncrypted`), verzeichnet es mit SHA-256 in
  `billing_batch_exports` und vermerkt den Lauf als übergeben. **Jeder weitere Download liefert genau diese Datei**
  (byte-gleich, Dateiname mit „-Nachdruck“, Header `X-Podo-Nachdruck: 1`, Prüfsumme im Header `X-Podo-Sha256` und auf
  der Seite). Das Archiv wird nie stillschweigend neu erzeugt: Ist die Datei unlesbar oder stimmt die Prüfsumme nicht,
  bricht der Download mit Hinweis auf den Support ab.
- **„nur Verordnungen (CSV)“** (`/api/export/gkv-batch/<lauf>`, bisheriger CSV-Link): liefert `verordnungen.csv` aus dem
  archivierten Paket (der erste Abruf archiviert das Paket ebenso).
- Im **Support-Modus** sind beide Downloads gesperrt (`downloadAllowed`, Arten `gkv_handover` bzw.
  `billing_batch_export`); Rückmeldungen und Auszahlungen kann der Support nicht erfassen.
- Läufe, die **vor Paket E** schon als CSV übergeben wurden, werden beim ersten Paket-Download mit dem dann aktuellen
  Stand archiviert; das Archiv ist als „nach Erstübergabe“ gekennzeichnet (`after_first_handover`, vom Datenbank-Trigger
  gesetzt), das LIESMICH und die Seite weisen darauf hin.

## 2. Übergabepaket (ZIP)

Dateiname: `Uebergabe-<JJJJ-MM-TT>-<erste 8 Zeichen der Lauf-ID>.zip` (Datum = Anlage des Laufs, Berliner Zeit).

| Datei | Inhalt |
|---|---|
| `verordnungen.csv` | eine Zeile je Verordnung des Laufs (Abschnitt 2.2) |
| `behandlungen.csv` | eine Zeile je Behandlungstag und Heilmittelposition (Abschnitt 2.3) |
| `abrechnungslauf.json` | gleicher Inhalt maschinenlesbar mit Schema-Version (Abschnitt 2.4) |
| `begleitzettel.pdf` | Deckblatt: Praxis (IK, Leistungserbringergruppe), Lauf, Summen, Liste der Verordnungen (Name, Personennummer, Versichertennummer, Kassen-IK, Ausstellungsdatum, Status, Heilmittelkosten, Zuzahlung, Kassenanteil) – ohne Diagnosen |
| `dokumente/leistungsnachweis/Leistungsnachweis_<Ausstellungsdatum>_<VO-ID 8>.pdf` | Leistungsnachweis je Verordnung (Behandlungen mit Positionen und Unterschrift bzw. Papier-Vermerk), nur wenn Behandlungseinträge vorhanden |
| `dokumente/therapiebericht/Therapiebericht_<Ausstellungsdatum>_<VO-ID 8>.pdf` | Therapiebericht (Position 78530), falls vorhanden |
| `LIESMICH.txt` | Kurzbeschreibung, Anzahlen, nicht erzeugbare Dokumente, Datenschutzhinweis |
| `PRUEFSUMMEN.sha256` | SHA-256 jeder anderen Datei im Format von `sha256sum` (`<hex>␣␣<pfad>`), sortiert; prüfen mit `sha256sum -c PRUEFSUMMEN.sha256` |

Es gehen **nur die Verordnungen des Laufs** ins Paket: abgerechnete Verordnungen mit diesem Lauf und Verordnungen, die in
diesem Lauf abgerechnet und danach zur Korrektur geöffnet bzw. in einem späteren Lauf neu abgerechnet wurden – diese mit
dem **Stand der Erstabrechnung** (`prescription_corrections.original_row`). Zeilensumme = Laufsumme.

### 2.1 Gemeinsame Regeln

- **CSV**: UTF-8 **mit BOM**, Trennzeichen **Semikolon**, Zeilenende CRLF, Felder mit `;`, `"` oder Zeilenumbruch in
  Anführungszeichen (`"` verdoppelt). Grund: deutsche Excel-Gewohnheit (Doppelklick öffnet die Datei korrekt); für
  Importprogramme ist das Format eindeutig.
- **Beträge in CSV**: Euro mit Komma, zwei Nachkommastellen, ohne Tausenderpunkt und ohne Währungszeichen (`1234,56`);
  leer = unbekannt (z. B. ohne Preis). **Beträge in JSON**: ganze **Cent** (`123456`), `null` = unbekannt.
- **Datum**: `JJJJ-MM-TT`; **Zeitpunkt** (JSON): ISO 8601 in UTC (`2026-11-19T08:00:00.000Z`).
- **Ja/Nein in CSV**: `ja` / `nein`.
- **Formel-Injection**: Textzellen, die mit `=`, `+`, `-`, `@`, Tab oder CR beginnen, bekommen ein vorangestelltes `'`
  (z. B. `'=HYPERLINK(…)`); reine negative Beträge wie `-12,50` bleiben unverändert. Importprogramme sollten ein
  führendes `'` vor diesen Zeichen entfernen.
- **IDs**: UUID (36 Zeichen, Kleinbuchstaben). Die **Verordnung-ID** ist dauerhaft und eindeutig – bitte in der
  Rückmeldung zurückgeben (Abschnitt 3).

### 2.2 `verordnungen.csv`

Die ersten 43 Spalten entsprechen dem bisherigen CSV-Export des Abrechnungslaufs (unverändert in Reihenfolge und
Schreibweise); die Spalten 44–52 sind mit Paket E hinzugekommen. Spalten werden künftig nur **hinten angehängt**.

| Nr. | Spalte | Typ | Beispiel / Werte |
|---|---|---|---|
| 1 | Lauf-ID | UUID | `3f1c…` |
| 2 | Verordnung-ID | UUID | `9a7e…` |
| 3 | Versichertennummer | Text (≤ 20) | `A000500015` – Stand der Verordnung bei Abrechnung, sonst der Person |
| 4 | Krankenkasse | Text | `Test-BKK` (Name laut Akte) |
| 5 | Nachname | Text | `Musterfrau` |
| 6 | Vorname | Text | `Erika` |
| 7 | Geburtsdatum | Datum | `1950-03-01` |
| 8 | Arzt | Text | `Dr. Beispiel` |
| 9 | LANR | Text (9 Ziffern) | `123456601` |
| 10 | BSNR | Text (9 Ziffern) | `123456789` |
| 11 | Ausstellungsdatum | Datum | `2026-10-01` |
| 12 | Diagnosegruppe | Text | `DF`, `NF`, `QF`, `UI1`, `UI2` |
| 13 | ICD-10 | Text | `E11.74` |
| 14 | Heilmittel | Text | Freitext laut Verordnung |
| 15 | Hausbesuch | ja/nein | |
| 16 | Dringlich | ja/nein | dringlicher Behandlungsbedarf (14 Tage) |
| 17 | Verordnete Einheiten | Ganzzahl | `6` |
| 18 | Erbrachte Einheiten | Ganzzahl | Anzahl Behandlungseinträge |
| 19 | Positionen (Nr:Bezeichnung:Einheiten) | Text | `78020:groß:6 \| 78220:Befund:1` (Trenner ` \| `) |
| 20 | Behandlungstage | Text | `2026-10-05 \| 2026-10-19` |
| 21 | Zuzahlung EUR | Betrag | gesetzliche Zuzahlung laut Preis-Snapshot (10 % + Verordnungsblattgebühr) |
| 22 | Zuzahlungsbefreit | Text | `ja`, `nein`, `minderjährig`, `gemischt (TT.MM.JJJJ befreit \| …)` |
| 23 | Zuzahlung erhalten am | Datum | letzte gültige Zuzahlungsquittung, sonst Altvermerk |
| 24 | Therapiebericht angefordert | ja/nein | Kreuz auf der Verordnung |
| 25 | Abbruch-/Unterbrechungsvermerk | Text | |
| 26 | Regelwerk | Text | `podo-2026-11-anlage3-2025-06` |
| 27 | IK Praxis | Text (9 Ziffern) | `109911114` |
| 28 | Leistungserbringergruppe | Text | Schlüssel der Praxis |
| 29 | IK Krankenkasse | Text (9 Ziffern) | Kassen-IK der Verordnung |
| 30 | Versichertenstatus | Text | `1` Mitglied, `3` Familienversichert, `5` Rentner:in |
| 31 | ICD-10 (2) | Text | zweiter ICD-Code |
| 32 | Diagnose (Klartext) | Text | |
| 33 | Leitsymptomatik | Text | `a`, `b`, `c` bzw. Freitext bei patientenindividueller Leitsymptomatik |
| 34 | Unfallfolgen | ja/nein | |
| 35 | BVG | ja/nein | |
| 36 | Heilmittelkosten EUR | Betrag | Summe laut Preis-Snapshot (Anlage 2) |
| 37 | Preisstand | Text | Preistabellen der Behandlungstage, z. B. `2025-07` |
| 38 | Zuzahlungsfrei angekreuzt (VO) | ja/nein | Kreuz „gebührenfrei“ auf der Verordnung |
| 39 | Verordnungsart | Text | `03` oder `04` (Anlage 3 § 302, 8.1.12; immer bestätigt) |
| 40 | Verordnungsbesonderheit | Text | z. B. `4 Verordnung im Rahmen des Entlassmanagements` |
| 41 | Genehmigung Kennzeichen | Text (≤ 20) | |
| 42 | Genehmigung Datum | Datum | |
| 43 | Korrektur | Text | `Korrektur offen`, `in späterem Lauf neu abgerechnet`, `Korrektur ohne Neuabrechnung`, `Neuabrechnung nach Korrektur vom JJJJ-MM-TT` |
| 44 | Status | Text | `abgerechnet` bzw. `Korrektur nötig` (Stand im Lauf) |
| 45 | Personennummer | Ganzzahl | Patientennummer der Praxis |
| 46 | Kassenanteil EUR | Betrag | Heilmittelkosten − Zuzahlung (leer ohne Heilmittelkosten) |
| 47 | Zuzahlung 10 % EUR | Betrag | 10-%-Anteil laut Snapshot |
| 48 | Verordnungsblattgebühr EUR | Betrag | 10 € bzw. gedeckelt (Vertrag § 8 Abs. 2) |
| 49 | Therapiebericht Datum | Datum | Berichtsdatum (78530), falls Bericht vorhanden |
| 50 | Behandlungen ohne Unterschrift | Ganzzahl | Anzahl Behandlungseinträge ohne Unterschrift/Papier-Vermerk |
| 51 | Leistungsnachweis (Datei) | Text | Pfad im ZIP, leer wenn nicht erzeugt |
| 52 | Therapiebericht (Datei) | Text | Pfad im ZIP, leer wenn kein Bericht |

### 2.3 `behandlungen.csv`

Eine Zeile je Behandlungstag und Heilmittelposition aus dem **Preis-Snapshot der Abrechnung** (Zuordnung der Einheiten
zu den Tagen siehe docs/GKV.md, offene Punkte 2 und 17). Position 78530 (Therapiebericht) steht mit dem Berichtsdatum.
Die Verordnungsblattgebühr steht nicht hier, sondern in `verordnungen.csv` (Spalte 48).

| Spalte | Typ | Bedeutung |
|---|---|---|
| Lauf-ID | UUID | |
| Verordnung-ID | UUID | Verweis auf `verordnungen.csv` |
| Versichertennummer | Text | |
| Ausstellungsdatum | Datum | der Verordnung |
| Datum | Datum | Behandlungstag (bzw. Berichtsdatum bei 78530) |
| Positionsnummer | Text | Heilmittelpositionsnummer (ZL-Schreibweise, z. B. `78020`) |
| Bezeichnung | Text | laut Verordnung (`Therapiebericht` bei 78530) |
| Einheiten | Ganzzahl | an diesem Tag |
| Einzelpreis EUR | Betrag | Preis je Einheit laut Anlage 2 an diesem Tag |
| Betrag EUR | Betrag | Einzelpreis × Einheiten |
| Zuzahlung EUR | Betrag | 10-%-Anteil dieser Zeile; leer = Position ohne Zuzahlung laut Anlage 2 (z. B. 78220, 78530); `0,00` = befreit/minderjährig |
| Zuzahlung befreit | ja/nein | Befreiungsbescheinigung gültig an diesem Tag |
| Minderjährig | ja/nein | unter 18 an diesem Tag |
| Preisstand | Text | Preistabelle, z. B. `2025-07` |
| Unterschrift | Text | `elektronisch`, `Papier`, je mit ` (nachgetragen)` wenn nicht am Behandlungstag; `fehlt`; `– (Therapiebericht)` bzw. `– (kein Behandlungseintrag)` |

Beispiel (gekürzt, fiktiv):

```
Lauf-ID;Verordnung-ID;Versichertennummer;Ausstellungsdatum;Datum;Positionsnummer;Bezeichnung;Einheiten;Einzelpreis EUR;Betrag EUR;Zuzahlung EUR;Zuzahlung befreit;Minderjährig;Preisstand;Unterschrift
3f1c…;9a7e…;A000500015;2026-10-01;2026-10-05;78020;groß;1;45,00;45,00;4,50;nein;nein;2025-07;elektronisch
```

### 2.4 `abrechnungslauf.json`

```json
{
  "schema": "podohero-abrechnung/1",
  "erzeugt": "2026-11-19T08:00:00.000Z",
  "hinweis": "Kein Datensatz nach § 302 SGB V – …",
  "praxis": { "name": "Testpraxis", "ik": "109911114", "leistungserbringergruppe": "…", "strasse": "Weg 2", "plz": "12345", "ort": "Musterstadt" },
  "lauf": {
    "id": "3f1c…", "erstellt": "2026-11-18T10:00:00.000Z", "frueher_uebergeben": null,
    "abrechnungszentrum": "anderes", "notiz": null, "anzahl_verordnungen": 1,
    "heilmittelkosten_cent": 9000, "zuzahlung_cent": 1900, "kassenanteil_cent": 7100
  },
  "summen_verordnungen": { "anzahl": 1, "heilmittelkosten_cent": 9000, "zuzahlung_cent": 1900, "kassenanteil_cent": 7100 },
  "verordnungen": [
    {
      "id": "9a7e…", "status": "billed", "korrektur": null,
      "person": { "nummer": 17, "nachname": "Musterfrau", "vorname": "Erika", "geburtsdatum": "1950-03-01", "strasse": "Teststr. 1", "plz": "12345", "ort": "Musterstadt" },
      "versicherung": { "krankenkasse": "Test-BKK", "kassen_ik": "109911114", "versichertennummer": "A000500015", "versichertenstatus": "1" },
      "arzt": { "name": "Dr. Beispiel", "lanr": "123456601", "bsnr": "123456789" },
      "ausstellungsdatum": "2026-10-01", "verordnungsart": "03",
      "verordnungsbesonderheit": null, "genehmigung": null,
      "diagnose": { "gruppe": "DF", "icd10": "E11.74", "icd10_zweit": null, "text": null, "leitsymptomatik": "c" },
      "heilmittel": null, "hausbesuch": false, "dringlich": false, "unfallfolgen": false, "bvg": false,
      "therapiebericht_angefordert": false, "einheiten_verordnet": 2, "einheiten_erbracht": 2,
      "positionen": [{ "nummer": "78020", "bezeichnung": "groß", "einheiten": 2 }],
      "behandlungen": [{ "datum": "2026-10-05", "unterschrift": "geraet", "nachgetragen": false }],
      "leistungen": [{ "datum": "2026-10-05", "position": "78020", "bezeichnung": "groß", "einheiten": 1, "einzelpreis_cent": 4500, "betrag_cent": 4500, "zuzahlung_cent": 450, "befreit": false, "minderjaehrig": false, "preisstand": "2025-07" }],
      "heilmittelkosten_cent": 9000, "zuzahlung_cent": 1900, "zuzahlung_10_prozent_cent": 900, "verordnungsblattgebuehr_cent": 1000,
      "kassenanteil_cent": 7100, "zuzahlungsbefreit": "nein", "zuzahlungsfrei_angekreuzt": false, "zuzahlung_erhalten_am": "2026-10-05",
      "abbruchvermerk": null, "regelwerk": "podo-2026-11-anlage3-2025-06",
      "therapiebericht": null,
      "dokumente": { "leistungsnachweis": "dokumente/leistungsnachweis/Leistungsnachweis_2026-10-01_9a7e1234.pdf", "therapiebericht": null }
    }
  ]
}
```

Felder wie in 2.2/2.3; `status` als Schlüssel (`billed`, `correction_needed`), `behandlungen[].unterschrift` als
Schlüssel (`geraet`, `papier`, `fehlt`). `lauf.frueher_uebergeben` ist gesetzt, wenn der Lauf vor dem Archiv schon
übergeben war (dann gibt das Paket den Stand beim Archivieren wieder). Neue Felder können in `podohero-abrechnung/1`
hinzukommen; Bedeutungsänderungen oder Wegfall nur mit neuer Version (`/2`).

## 3. Rückmeldung (Auszahlung, Absetzungen)

Je Datei **eine Auszahlung** (ein Auszahlungsdatum, eine Sammelrechnungsnummer). Eingelesen wird am Abrechnungslauf
(„Rückmeldung einlesen“): **Vorschau** (prüft und ordnet zu, ändert nichts) → **Übernehmen** (dieselbe Datei, über die
Prüfsumme festgestellt). Zeilen mit einer **anderen Lauf-ID** werden übersprungen (eine Datei für mehrere Läufe kann an
jedem Lauf eingelesen werden). Dieselbe Datei lässt sich je Lauf nur **einmal** übernehmen (SHA-256 der Datei).

Ergebnis beim Übernehmen:

- eine **Auszahlung** (`billing_batch_payouts`): Summe „ausgezahlt“ der Zeilen dieses Laufs, Summe der Absetzungen,
  Auszahlungsdatum, Sammelrechnungsnummer, je Verordnung der Betrag (`details`, ohne Namen/Diagnosen), Prüfsumme der Datei;
- je Zeile mit Absetzung eine **Absetzung** (`gkv_deductions`, Status „offen“, Datum = Auszahlungsdatum,
  Kassenschreiben/Aktenzeichen = Sammelrechnungsnummer, Notiz „aus Rückmeldung des Abrechnungszentrums eingelesen“,
  verknüpft über `payout_id`) – weiter bearbeitet unter **Verordnungen → GKV-Abrechnung → Absetzungen**. Eine gleiche
  Absetzung (Verordnung, Betrag, Code) wird nicht doppelt angelegt;
- **keine Änderung an Verordnungen** (Status, Beträge bleiben).

### 3.1 CSV

UTF-8 (mit oder ohne BOM), Trennzeichen Semikolon oder Komma, erste Zeile = Kopf mit **genau diesen Spalten** (Reihenfolge
beliebig, Groß-/Kleinschreibung egal):

| Spalte | Pflicht | Typ / Format |
|---|---|---|
| Verordnung-ID | ja¹ | UUID aus dem Übergabepaket |
| Lauf-ID | nein | UUID; andere Lauf-ID → Zeile wird übersprungen |
| Versichertennummer | ja¹ | Buchstaben/Ziffern, ≤ 20 (Leerzeichen werden entfernt) |
| Ausstellungsdatum | ja¹ | `JJJJ-MM-TT` oder `TT.MM.JJJJ` |
| Ausgezahlt EUR | ja | `123,45` oder `123.45` – ohne Vorzeichen, ohne Tausendertrennzeichen, höchstens 2 Nachkommastellen, ≤ 100.000 € |
| Absetzung EUR | nein | wie oben, ≤ 10.000 €; leer oder `0` = keine Absetzung |
| Absetzung Code | nein | Text ≤ 20 (Absetzungs-/Retaxcode) |
| Absetzung Grund | bei Absetzung | Text 3–500 Zeichen (ohne Gesundheitsangaben formulieren) |
| Auszahlungsdatum | ja | `JJJJ-MM-TT` oder `TT.MM.JJJJ`, nicht in der Zukunft, nicht vor 2000; in allen Zeilen gleich |
| Sammelrechnungsnummer | nein | Text ≤ 60; in allen Zeilen gleich |

¹ Zuordnung: **Verordnung-ID** (empfohlen) **oder** Versichertennummer **und** Ausstellungsdatum. Sind beide angegeben,
müssen sie zusammenpassen. Gibt es zu Versichertennummer + Ausstellungsdatum mehrere Verordnungen im Lauf, ist die
Verordnung-ID nötig.

Beispiel (fiktiv):

```
Verordnung-ID;Lauf-ID;Versichertennummer;Ausstellungsdatum;Ausgezahlt EUR;Absetzung EUR;Absetzung Code;Absetzung Grund;Auszahlungsdatum;Sammelrechnungsnummer
9a7e…;3f1c…;;;58,50;12,50;R12;Unterschrift unleserlich;2026-11-28;SR-2026-0815
;;A000500015;01.10.2026;71,00;;;;28.11.2026;SR-2026-0815
```

### 3.2 JSON

```json
{
  "schema": "podohero-rueckmeldung/1",
  "sammelrechnungsnummer": "SR-2026-0815",
  "auszahlungsdatum": "2026-11-28",
  "positionen": [
    { "verordnung_id": "9a7e…", "lauf_id": "3f1c…", "ausgezahlt_cent": 5850,
      "absetzung": { "betrag_cent": 1250, "code": "R12", "grund": "Unterschrift unleserlich" } },
    { "versichertennummer": "A000500015", "ausstellungsdatum": "2026-10-01", "ausgezahlt_cent": 7100 }
  ]
}
```

Beträge als ganze Cent (`ausgezahlt_cent` ≥ 0, `absetzung.betrag_cent` ≥ 1). Unbekannte Felder sind ein Fehler
(strikte Prüfung). Erkennung: Dateiendung `.json` oder Inhalt beginnt mit `{`.

### 3.3 Prüfung (strikt, alles oder nichts)

- höchstens **1 MB** und **5.000 Zeilen** je Datei; gültiges UTF-8; keine Binärdaten;
- jede Zeile einzeln geprüft (Meldung mit Zeilen- bzw. Positionsnummer, höchstens 50 Meldungen); eine Verordnung höchstens
  einmal je Datei; bei **einem** Fehler wird **nichts** übernommen;
- Zuordnung nur zu Verordnungen dieses Laufs (wie im Übergabepaket); nicht zuordenbar → Fehler;
- Absetzung nur zu einer (noch) abgerechneten Verordnung;
- Inhalte werden **nie ausgewertet** (keine Formeln, keine Makros): Textfelder bleiben Text, Steuerzeichen werden entfernt;
- Hinweise ohne Sperre: „ausgezahlt + Absetzung“ weicht vom Kassenanteil laut Lauf ab; Absetzung ohne Code.

## 4. Archiv und Aufbewahrung

- `billing_batch_exports` (Migration 0068): je Lauf und Art (`handover_zip`) höchstens ein Eintrag; Speicherschlüssel,
  SHA-256 des Klartexts, Größe, Dateiname, Format-Version, Anzahl, `after_first_handover`, `created_by`, `created_at`.
  **Append-only**: kein UPDATE/DELETE/TRUNCATE (Trigger; App-Rolle zusätzlich ohne UPDATE/DELETE, scripts/migrate.ts).
  Zeitpunkt und `after_first_handover` setzt der Trigger; Speicherschlüssel nur im Bereich der eigenen Praxis.
- `billing_batch_payouts` (Migration 0068): **append-only** wie oben; nur zu einem **übergebenen** Lauf; `source` =
  `import` (mit Prüfsumme der Datei, eindeutig je Lauf) oder `manual` (von Hand erfasst, ohne Datei).
- Beide Tabellen: `organization_id`, RLS ENABLE + FORCE mit `tenant_isolation` (USING + WITH CHECK), Verweise nur
  innerhalb der Praxis (`podo_fk_same_org`), `created_by` nur Mitglieder der Praxis (`podo_user_in_org`).
- Gelöscht wird beides nur mit der Praxis (Löschlauf als Eigentümer, `src/server/purge-organization.ts`, erfasst neue
  Tabellen automatisch; danach wird das Speicherverzeichnis der Praxis gelöscht). Keine Personen-Spalten: Personen mit
  abgerechneten Verordnungen sind ohnehin nicht vollständig löschbar (`podo_delete_patient`).
- **Praxis-Export**: archivierte Pakete unter `abrechnung/uebergabe/<Dateiname>` (byte-gleich, gegen SHA-256 geprüft),
  Zuordnung in `tables/billing_batch_exports.json` (Feld `exportFile`); Auszahlungen in
  `tables/billing_batch_payouts.json`.
- **Verwaiste Dateien**: `scripts/archive-orphans.ts` kennt `billing_batch_exports` (KNOWN_TABLES).
- **Audit** ohne Gesundheitsdaten: `billing_batch.handover` (Nachdruck ja/nein, Format, Anzahl, Größe, Prüfsumme),
  `billing_batch.payout_preview`, `billing_batch.payout_import` (Anzahlen, Summen, Prüfsumme der Datei – keine Gründe,
  keine Namen), `billing_batch.payout_manual` (Betrag, Datum).
