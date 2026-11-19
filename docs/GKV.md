# GKV-Grundlagen Podologie (Kassenpraxen)

Stand: 19.11.2026 · Regelwerk `podo-2026-11-anlage3-2025-06` (`RULES_VERSION` in `src/lib/rules/prescription.ts`)

PodoHero unterstützt Praxen mit Kassenzulassung (Heilmittelverordnung Muster 13, Vertrag nach § 125 Abs. 1 SGB V
Podologie). Alle Kassen-Themen bleiben über den Praxis-Modus abschaltbar (`organizations.settings.billingMode =
"private_only"`, `src/lib/features.ts`): dann sind Verordnungen, Zuzahlung, Kassenzulassung, GKV-Positionen und die
Verordnungsauswahl im Terminformular ausgeblendet bzw. serverseitig gesperrt.

Grundsatz: **Keine Regel, kein Preis und keine Frist ohne Quelle.** Jede fachliche Konstante steht mit Dokument und
Abschnitt im Code-Kommentar und in der Tabelle unten. Was nicht sicher belegt ist, meldet PodoHero als Hinweis
„bitte prüfen“, nicht als Fehler.

## Quellen (gelesen am 17.11.2026)

| Kürzel | Dokument | Fundstelle | Gelesen |
|---|---|---|---|
| Anlage 2 | GKV-Spitzenverband, Podologie Anlage 2 „Vergütung“ i. d. F. vom 01.07.2025 (unterzeichnet 16.06.2025) | https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_2.pdf | vollständig (PDF, Text extrahiert) |
| Anlage 3 | GKV-Spitzenverband, Podologie Anlage 3 „notwendige Angaben auf der Heilmittelverordnung“, Lesefassung i. d. F. vom 16.06.2025 | https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_3_Lesefassung.pdf | vollständig |
| Vertrag | Vertrag nach § 125 Abs. 1 SGB V Podologie i. d. F. vom 30.11.2020, Lesefassung inkl. Änderungen bis 16.06.2025 | https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Vertrag-Lesefassung.pdf | §§ 4–8, 17, 18 |
| HeilM-RL | G-BA Heilmittel-Richtlinie, zuletzt geändert 15.05.2025 (in Kraft 05.08.2025), inkl. Heilmittelkatalog Teil 2 Abschnitt II Podologie | https://www.g-ba.de/richtlinien/12/ | §§ 7, 15, 16, 27–28b, Katalog DF/NF/QF/UI1/UI2 |
| KVNR-RL | Richtlinie zum Aufbau und zur Vergabe einer Krankenversichertennummer nach § 290 SGB V, Stand 21.10.2025, und Anlage 1 „Prüfziffernberechnung“ (Stand 02.01.2023) | https://www.gkv-datenaustausch.de/media/dokumente/kvnr/Richtlinie_20251021_Gesamtsystem-KVNR__290_SGBV_3.4.1_fin.pdf · https://www.gkv-datenaustausch.de/media/dokumente/kvnr/Anlage_1_20230102_Pruefziffernberechnung-KVNR.pdf | Tabelle 1, Z. 175–183; Anlage 1 komplett |
| ANRV | Vereinbarung gemäß § 293 Abs. 4 und 7 SGB V über eine zentrale Arztnummernvergabe vom 17.10.2018 | https://www.kbv.de/documents/infothek/rechtsquellen/weitere-vertraege/praxen/arzt-und-betriebsstaettennummer/ANRV-Vereinbarung.pdf | § 4 |
| TA1 | Technische Anlage zum Vertrag über den Datenaustausch (Anlage 6 BMV-Ä), Version 1.23 vom 03.06.2024 | https://www.gkv-datenaustausch.de/media/dokumente/leistungserbringer_1/aerzte/technische_anlagen___archiv/20240603_TA1_23.pdf | Abschnitt 4.4.1, Feld 6/6.2.1 |
| SGB V | §§ 32 Abs. 2, 61 Satz 3, 62 SGB V | https://www.gesetze-im-internet.de/sgb_5/ | Wortlaut |
| ICD-10-GM | BfArM ICD-10-GM 2026, Block E10–E14 | https://klassifikationen.bfarm.de/icd-10-gm/kode-suche/htmlgm2026/block-e10-e14.htm | 4. und 5. Stelle |

Nicht lesbar war keines der vorgegebenen Dokumente. Nicht ausgewertet: ältere Fassungen der Anlage 2 (Preise vor dem
01.07.2025), Anlagen 1a–1c (Leistungsbeschreibung), die Diagnoseliste langfristiger Heilmittelbedarf (Anlage 2 HeilM-RL)
und die KBV-Richtlinie zur Vergabe der Betriebsstättennummer.

## Regeln und Konstanten

| Regel | Wert | Quelle | Code |
|---|---|---|---|
| Spätester Behandlungsbeginn | 28 Kalendertage nach Ausstellung, dringlich 14 | HeilM-RL § 15 Abs. 1; Vertrag § 6 Abs. 3; Anlage 3 Buchst. e | `START_DEADLINE_DAYS` |
| Beginn verpasst → ungültig | „Frist überschritten“ (Status `expired`, Grund `start_missed`); nicht bei Status „in Behandlung“ ohne erfassten Behandlungstag (Beginn außerhalb von PodoHero, z. B. Übernahme) | HeilM-RL § 15 Abs. 2; Vertrag § 6 Abs. 4 | `evaluatePrescription`, `expireOverdue` |
| Automatischer Ablauf | nur Verordnungen ab Regelwerk `podo-2026-11` (`RULES_MIN_ANLAGE3`), nur in protokollierten Pfaden mit Schreibrecht (Akte, Übersicht; nicht Support-/Nur-Lesen-Modus); Doku-Auswahl, Terminplanung und Besuchstag filtern nur | Produktentscheidung (Review PR #111 H1/C1) | `autoExpiryApplies`, `canAutoExpire` |
| Rückweg aus „Frist überschritten“ | nur mit Begründung (≥ 5 Zeichen, protokolliert, `reopen_note`); Beginnfrist gilt dann als bestätigt, 12-Wochen-Frist zählt ab der Wiederaufnahme | Produktentscheidung (Review PR #111 C1) – Verantwortung der Praxis | `canTransition`, `reopenedOn` |
| Unterbrechung | ungültig nach 12 Kalenderwochen nach der letzten Behandlung; Übernahme „in Behandlung“ ohne erfassten Tag: ab Übernahmedatum (`created_at`), gelbe Ampel + Hinweis beim Buchen, danach nicht mehr buchbar (kein automatischer Ablauf) | Vertrag § 7 Abs. 7 (HeilM-RL § 16 Abs. 4 Satz 5: die 14-Tage-Regel gilt für Podologie nicht) | `INTERRUPTION_WEEKS` |
| Frequenz-Toleranz | ± 2 Werktage ohne Rücksprache | Vertrag § 7 Abs. 6 | `FREQUENCY_TOLERANCE_WORKDAYS` |
| Frequenzabweichung darüber | nur nach Absprache mit der Ärztin/dem Arzt, auf der VO dokumentieren → Begründung je Behandlung Pflicht; zwei Einträge am **selben Tag** (z. B. Befundung + Behandlung) sind keine Abweichung | HeilM-RL § 16 Abs. 3; Anlage 3 Buchst. i a); Vertrag § 7 Abs. 6 (Abstand zwischen Behandlungen) | `frequencyDeviation`, `prescriptionGate` |
| Keine Frequenz auf der VO | Katalog-Frequenz gilt (DF/NF/QF: alle 4–6 Wochen) | Anlage 3 Buchst. i b); Heilmittelkatalog | `DIAGNOSIS_GROUPS[].defaultFrequency` |
| UI1/UI2-Frequenz | nur Empfehlung, keine Begründung nötig | Anlage 3 Buchst. i | `frequencyBinding: false` |
| Höchstmenge je VO | DF/NF/QF 6, UI1 8, UI2 4 (darüber: nur Höchstmenge abrechenbar, Arzt informieren) | Heilmittelkatalog; Anlage 3 Buchst. f b) | `maxUnitsPerPrescription` |
| ICD-10 DF | muss DFS oder diabetische Neuropathie deklarieren: E10–E14 mit „.4“ (neurologische Komplikationen, inkl. G63.2*) oder „.74“/„.75“ (diabetisches Fußsyndrom); andere → **Hinweis „bitte prüfen“** | Anlage 3 Buchst. k a); ICD-10-GM 2026 | `icdMatchesGroup` |
| ICD-10 UI1/UI2 | ausschließlich L60.0, sonst Korrektur nötig (Fehler vor Abrechnung) | Anlage 3 Buchst. k c); Heilmittelkatalog | `icdMatchesGroup` |
| ICD-10 NF/QF | keine Schlüsselliste belegt → nur Format | – | – |
| Positionen ↔ Diagnosegruppe | 78010–78040 nur DF/NF/QF; 78100–78620 nur UI; 78210–78400 nur VO bis 30.09.2025, 78610/78620 ab 01.10.2025 | Anlage 2 § 2 Abs. 2 Buchst. a–d | `positionFits` |
| Hausbesuch | 79933/79934 nur mit „Hausbesuch: ja“ auf der VO | Anlage 3 Buchst. c; Anlage 2 § 2 Abs. 2 Buchst. e | `anlage3Findings` |
| Zuzahlung | 10 % der Kosten + 10 € je Verordnung, höchstens die Kosten; die Gebühr wird dafür gedeckelt (Gebühr = min(10 €, Kosten − 10-%-Anteil)), sodass Zuzahlung = Anteil + Gebühr gilt (z. B. nur 78030 zu 3,47 €: 0,35 € + 3,12 €) | SGB V § 61 Satz 3, § 32 Abs. 2; Vertrag § 8 Abs. 1 | `priceSnapshot` |
| 10-%-Anteil | nach dem Alter am **Behandlungstag** (ab Vollendung des 18. Lebensjahres) | Vertrag § 8 Abs. 2 Satz 1–2 | `priceSnapshot` |
| 10 € Verordnungsblattgebühr | nach dem **ersten Behandlungstag**; nur, wenn für diesen Tag ein Preis hinterlegt ist | Vertrag § 8 Abs. 2 Satz 3 | `priceSnapshot` |
| Zuzahlung je Snapshot-Zeile | `null` = Position ohne Zuzahlung laut Anlage 2 (78220, 78530); `0` = befreit bzw. unter 18 | Anlage 2 § 2/§ 3 (Spalte „davon Zuzahlung (nachrichtlich)“) | `SnapshotLine.copayCents` |
| Doppelte Positionen | gleiche Positionsnummer mehrfach auf der VO → beim Speichern zusammengefasst (Einheiten addiert) | Review PR #111 Runde 2 | `mergePositions` |
| „In Behandlung“ | bei mit PodoHero erfassten VOs nur durch die erste dokumentierte Einheit (`statusAfterUnit`), nicht per Statuswechsel; „anderswo begonnen“ gilt nur für Übernahmen/Altbestand | Beginnfrist HeilM-RL § 15; Review PR #111 Runde 2 S-1 | `canTransition`, `evaluatePrescription` |
| Abrechnungsreif | nur mit vollständigem Preis-Snapshot (jede Position mit Positionsnummer und Preis am Behandlungstag) | Vertrag § 8 Abs. 1 (Zuzahlung aus den Kosten); Review PR #111 S2 | `changePrescriptionStatus` |
| Snapshot-Zeilen | je (Behandlungstag, ZL-Positionsnummer) genau eine Zeile: Behandlungseinträge werden je Kalendertag zusammengefasst, BEVOR verteilt wird – je Tag höchstens die Tageshöchstmenge (78610: 2, sonst 1, vorzeitig beendet 1); mehr Einträge am selben Tag als die Tageshöchstmenge → Hinweis „n Behandlungseinträge am … – nur 1 Einheit (78610: 2 Einheiten) abrechenbar“, Rest „nicht verteilbar“; doppelte Positionen auf der VO vorher zusammengefasst (Hinweis „mehrfach auf der Verordnung“); gedeckelte Pauschale und Befreiung einer anderen Kasse (einmal je Befreiung, IK normalisiert) stehen als Hinweis | Export #110 (Position je Tag eindeutig); Anlage 2 § 2 Abs. 2 Buchst. c; Review PR #111 Runden 3 und 4 | `priceSnapshot`, `mergePositions` |
| 78610 je Tag | bis zu zweimal je Tag; im Snapshot so verteilt, dass die verordneten Einheiten auf die Behandlungstage passen; vorzeitig beendete VO (Abbruchvermerk) nur einmal je Tag; jede Annahme „2 × am Tag“, nicht verteilbare Einheiten und mehr Einträge am selben Tag als erlaubt (bei 78610 ab drei Einträgen; zwei Einträge → kein Hinweis) stehen als Hinweis im Snapshot | Anlage 2 § 2 Abs. 2 Buchst. c | `GkvPosition.maxPerDay`, `priceSnapshot` |
| Abgerechnet | unveränderbar (DB-Trigger `prescriptions_billed_lock`); die Zuzahlung wird seit Paket B als Zuzahlungsquittung (Beleg ZZ) erfasst – auch nach der Abrechnung, ohne die Verordnung zu ändern; ein Altvermerk „Zuzahlung erhalten“ kann nicht mehr neu gesetzt, nur als „Vermerk war falsch“ entfernt werden; Neuberechnung des Snapshots (abrechnungsreif → abgeschlossen → abrechnungsreif) protokolliert den alten Snapshot | GoBD-Nachvollziehbarkeit; Review PR #111 S1 | Migration 0062 |
| Abrechnungslauf | nur Verordnungen mit vollständigem Preis-Snapshot | Review PR #111 Runde 2 | `createBillingBatch` |
| „Zuzahlung erhalten“ (Paket B) | **Zuzahlungsquittung** (Beleg ZZ, siehe Abschnitt „Paket B“) mit Kassenbuchung; Betrag streng geprüft (Punkt bzw. Leerzeichen nur als Tausendertrenner im Muster 1.234,56 / 1 234,56, sonst Punkt = Dezimaltrenner; höchstens 20 Zeichen); Summe aller Quittungen höchstens die Heilmittelkosten der VO (Snapshot bzw. Schätzung), ohne bekannte Kosten 10.000 € und über 200 € nur mit ausdrücklicher Bestätigung; über bzw. unter der berechneten Zuzahlung → Hinweis (Restbetrag offen). Der frühere Vermerk `copayment_paid_*` ist nur noch **Altvermerk** (Anzeige, zurücksetzbar, keine nachträgliche Kassenbuchung) | SGB V § 61 Satz 3, § 32 Abs. 2; Vertrag § 8; Review PR #111 Runden 2 und 3 | `createCopaymentReceipt`, `parseEuroInputCents`, `copaymentPaidHint` |
| Unterschrift je Behandlung (Paket B) | Bestätigung der versicherten Person (bzw. Betreuungsperson/Angehörige:r) je Behandlung auf dem Gerät oder bewusster Vermerk „Unterschrift auf der Papier-Verordnung (Rückseite)“; unveränderbar; ohne Bestätigung „Unterschrift fehlt“, **„abrechnungsreif“ gesperrt** (Verordnungen ab `podo-2026-11`; Übernahmen/Altbestand nur Hinweis) | Vertrag § 125 SGB V Podologie, Anlage 3 Buchst. o | `treatment_signatures`, `changePrescriptionStatus` |
| Löschung der Person | abgerechnete Verordnung (`billed_at`), Altvermerk „Zuzahlung erhalten“ (`copayment_paid_at`) oder Zuzahlungsquittung (Beleg ZZ inkl. Storno, wie jeder Beleg) = aufbewahrungspflichtig, keine vollständige Löschung | § 147 AO; AppSec PR #111 N1 | `retentionFacts`, `podo_delete_patient` (0062) |
| Zuzahlungsbefreiung | nur mit gültiger Bescheinigung der Kasse (Kreuz auf der VO genügt nicht); über den Jahreswechsel neu prüfen; Bescheinigung einer anderen Kasse als auf der VO → Hinweis „bitte prüfen“; höchstens 50 Einträge je Person | Vertrag § 8 Abs. 3; Anlage 3 Buchst. a1; SGB V § 62 Abs. 1 | `exemptOn`, Befreiungskarte, CHECK `patients_copayment_exemptions_max` |
| Pflichtangaben VO | siehe nächster Abschnitt | Anlage 3 Ziff. 3 und 5 | `anlage3Findings` |
| IK-Prüfziffer | Stellen 3–8 × 2,1,2,1,2,1, Quersummen addieren, mod 10 | KVNR-RL Anlage 1 (Beispiel IK 109911114) | `isValidIk` |
| KVNR | Buchstabe + 8 Ziffern + Prüfziffer; Buchstabe → 01–26, Faktoren 1,2,1,2…, Quersummen, mod 10 | KVNR-RL Tabelle 1, Anlage 1 (A000500015, C000500021) | `isValidKvnr` |
| LANR | Stellen 1–6 × 4,9,4,9,4,9, Summe mod 10, Prüfziffer = 10 − Rest (10 → 0) an Stelle 7; Stellen 8–9 Fachgruppe | ANRV § 4 Abs. 2–4 | `isValidLanr` |
| BSNR | 9 Ziffern (keine Prüfziffer belegt) | – | `bsnrProblem` |
| Versichertenstatus | 1 Mitglied, 3 Familienangehörige, 5 Rentner | TA1 Feld 6/6.2.1 | `INSURED_STATUS` |
| Leistungserbringergruppe | 7100501 Podologen, 7200501 Med. Fußpfleger, 2700541 Krankenhaus, 2800541 Kurbetrieb | Anlage 2 § 1 Abs. 1; Vertrag § 18 Abs. 7 | `LEGS_PODOLOGIE` |
| Positionsnummer je Status | ZL 7xxxx, KH 6xxxx, KB 8xxxx | Anlage 2 § 1 Abs. 2 | `hpnrFor`, `toZlHpnr` |

### Pflichtangaben nach Anlage 3 (Prüfstufen)

- **Fehler – Behandlung darf nicht beginnen** (Buchung einer Einheit wird abgelehnt): Versichertennummer fehlt, IK der
  Krankenkasse fehlt, LANR fehlt (Ziff. 5 Buchst. a), Diagnose fehlt, Heilmittel fehlt (Ziff. 3), Arztstempel/Unterschrift
  fehlen (Ziff. 3, Buchst. n).
- **Fehler – vor der Abrechnung korrigieren** („abrechnungsreif“ gesperrt): IK der Kasse mit falscher Prüfziffer,
  UI1/UI2 ohne L60.0, Position passt nicht zur Diagnosegruppe/zum Verordnungsdatum, Hausbesuchsposition ohne „ja“,
  IK der Praxis fehlt/ungültig (Buchst. p, Vertrag § 17).
- **Bitte prüfen** (Hinweis): Versichertenstatus fehlt, BSNR fehlt (darf aus dem Stempel übernommen werden), LANR- oder
  KVNR-Prüfziffer passt nicht, DF-ICD nicht eindeutig, Leitsymptomatik fehlt (DF/NF/QF), Frequenz fehlt, Höchstmenge
  überschritten.

Die Prüfung gilt für Verordnungen ab dem Regelwerk `podo-2026-11` (`hasAnlage3Fields`, auch für spätere Fassungen);
ältere und übernommene Verordnungen hatten die Felder nicht. Fristen (Beginn, Unterbrechung) und die
Frequenz-Begründung werden bei der Buchung für alle laufenden Verordnungen geprüft; automatisch auf „Frist
überschritten“ gesetzt werden aber nur Verordnungen ab `podo-2026-11` (Übernahmen und Altbestand bleiben, wie sie sind).

## Vergütung (Anlage 2)

Preise und „davon Zuzahlung (nachrichtlich)“ stehen versioniert in `src/lib/rules/podologie-verguetung.ts`
(`PRICE_VERSIONS`: ab 01.07.2025 laut § 2, ab 01.07.2026 laut § 3). Maßgeblich ist das Behandlungsdatum. Leistungen der
Praxis werden in Einstellungen → Leistungen per Auswahl an eine Position gekoppelt. Beim Setzen auf „abrechnungsreif“
speichert PodoHero je Verordnung einen **Preis-Snapshot** (Positionen, Preise je Behandlungstag, Tabellenstand,
Zuzahlung je Tag, Befreiung, Minderjährigkeit) sowie die Heilmittelkosten (`prescriptions.price_snapshot`,
`remedy_cost_cents`). Der Abrechnungslauf summiert Heilmittelkosten und Zuzahlungen (`billing_batches.remedy_total_cents`,
`copayment_total_cents`), der CSV-Export enthält zusätzlich IK der Praxis, LEGS, Kassen-IK, Status, 2. ICD,
Leitsymptomatik, Unfall/BVG, Heilmittelkosten und Preisstand. Die Spalte „Zuzahlungsbefreit“ kommt aus dem Snapshot
(„ja“, „nein“, „minderjährig“ oder „gemischt (TT.MM.JJJJ befreit | …)“ je Behandlungstag); das Kreuz der Verordnung
steht in „Zuzahlungsfrei angekreuzt (VO)“ (letzte Spalte).

Neue Fassung: neue Version mit `validFrom` anhängen, bestehende Werte nie ändern; `RULES_VERSION` hochsetzen.

**Datenmigrationen auf `prescriptions`:** Abgerechnete Zeilen sind per Trigger `prescriptions_billed_lock` gesperrt. Künftige
Migrationen, die `prescriptions` ändern, müssen abgerechnete Zeilen ausfiltern (`WHERE status <> 'billed'`) oder den
Trigger bewusst und begründet für die Dauer der Migration abschalten (`ALTER TABLE … DISABLE/ENABLE TRIGGER`), sonst
bricht die Migration ab.

## Stammdaten

- Praxis (Einstellungen → Praxis → Kassenzulassung): IK (Prüfziffer), Leistungserbringergruppe, Zulassungsdatum,
  Vertragsstand (`organizations.ik`, `legs_code`, `gkv_admission_date`, `gkv_contract_note`).
- Person: IK der Krankenkasse, Versichertenstatus, KVNR (Prüfziffer als Hinweis), Befreiungsbescheinigungen mit
  Gültig-von/-bis und Kasse (`patients.insurer_ik`, `insured_status`, `copayment_exemptions`).
- Verordnung: Personalienfeld (KVNR, Kassen-IK, Status – aus der Akte vorbelegt), bis zu zwei ICD-10, Klartext-Diagnose,
  Leitsymptomatik a/b/c bzw. Freitext, Unfallfolgen/BVG, Arztstempel/Unterschrift.
- Import: `extra.payerIk` (Pododesk/Tinana) wird von Migration 0061 in `patients.insurer_ik` übernommen (nur 9 Ziffern,
  idempotent; der Schlüssel in `extra` entfällt), Pododesk-„versichertenstatus“ 1/3/5 in `insured_status`. IK und
  Kassenzulassung aus den Pododesk-Praxisstammdaten erscheinen in der Import-Vorschau als **Vorschlag** und werden nur per
  Klick und nur in leere Felder übernommen. Tinana liefert keine Praxisstammdaten.

## Termine gegen Verordnung

Im Terminformular (Seite und Fenster) ist eine laufende Verordnung der Person vorausgewählt (älteste zuerst, Vertrag § 7
Abs. 5). Warnungen beim Planen: Restmenge (inkl. schon geplanter, nicht dokumentierter Termine), Termin nach dem
spätesten Behandlungsbeginn, mehr als 12 Wochen Abstand, Frequenzabweichung (dann bei der Behandlung Begründung nötig).
Gespeichert wird trotzdem (`appointments.prescription_id`). Die Einheit zählt erst mit der Behandlungsdoku.

## Deploy-Hinweise (PR #111)

- Migration `0062_gkv_review.sql` nur über `scripts/migrate.ts` (eine Transaktion) bzw. `psql -1` einspielen: Sie setzt
  `FORCE ROW LEVEL SECURITY` für `appointments`/`prescriptions` kurz aus; bricht sie ohne Transaktion ab, bliebe FORCE aus.
- **Altbestand „in Behandlung“ ohne Behandlungseintrag** (Review H-5): Verordnungen mit älterem App-Regelwerk (nicht
  `import-…`, nicht ab `podo-2026-11`) gelten als „anderswo begonnen“; die 12-Wochen-Unterbrechung zählt jetzt ab
  `created_at` (für Übernahmen `import-…` ebenso). Wie viele dadurch nach dem Deploy nicht mehr buchbar wären, zählt
  diese **reine Lese-Abfrage** – als Superuser bzw. Rolle mit BYPASSRLS (z. B. `postgres`) ausführen, **nicht** als
  `podo_owner`/`podo_app` (FORCE RLS → 0 Zeilen); nicht automatisch ausgeführt:

```sql
-- Nur lesen. Zählt je Praxis die laufenden Altbestand-VOs ohne Behandlungseintrag, deren 12-Wochen-Frist ab Anlage
-- (bzw. ab einer späteren Wiederaufnahme) abgelaufen ist (evaluatePrescription: heute > Bezugstag + 84 Tage).
SELECT p.organization_id, (coalesce(p.rules_version, '') LIKE 'import-%') AS uebernahme, count(*) AS gesperrt
  FROM prescriptions p
 WHERE p.status = 'active'
   AND NOT (coalesce(p.rules_version, '') ~ '^podo-\d{4}-\d{2}' AND substring(p.rules_version FROM 6 FOR 7) >= '2026-11')
   AND NOT EXISTS (SELECT 1 FROM treatment_records t WHERE t.prescription_id = p.id)
   AND greatest((p.created_at AT TIME ZONE 'Europe/Berlin')::date, coalesce(p.reopened_at, '-infinity'::date))
       < (now() AT TIME ZONE 'Europe/Berlin')::date - 84
 GROUP BY p.organization_id, uebernahme
 ORDER BY gesperrt DESC;
```

## Paket B: Unterschrift, Leistungsnachweis, Zuzahlungsquittung (PR „GKV Paket B“)

**Unterschrift je Behandlung.** Beim Behandlungseintrag auf eine Verordnung (Doku-Formular, Besuchstag-Zeile im
Pflegeheim) unterschreibt die versicherte Person – bzw. rechtliche Betreuung/Bevollmächtigte:r, Angehörige:r oder
Pflegekraft der Einrichtung – auf dem Gerät (Finger/Stift, Feld `SignatureField`), mit Name (ohne Steuerzeichen) und
Rolle; Zeitstempel = Speicherzeitpunkt. Das Bild (PNG genau 900×300, 8 Bit RGBA, nur IHDR/IDAT/IEND plus kleine
Farbraum-Chunks, keine APNG, höchstens 200 KB, IDAT probeweise mit Obergrenze entpackt – `src/lib/signature-png.ts`) liegt verschlüsselt in der Dateiablage (`src/lib/storage.ts`, Schlüssel
`<praxis>/…/<uuid>.bin`), nie als Blob in der Datenbank. Alternativ das bewusst gesetzte Häkchen „Unterschrift auf der
Papier-Verordnung (Rückseite) erfasst“. Tabelle `treatment_signatures` (Migration 0064): je Behandlung höchstens eine
Zeile, append-only (Trigger), Eintrag/Person/Verordnung müssen zusammenpassen, Verweise nur innerhalb der Praxis, RLS +
FORCE. Audit `record.signature` bzw. `record.signature_paper` (ohne Namen/Bilddaten), Ansicht `record.signature_view`.
Fehlt die Unterschrift, steht an der Verordnung „Unterschrift fehlt (n von m)“; nachtragen im **Leistungsnachweis**
(`/kunden/<id>/verordnungen/<vo>/nachweis`, Recht `medical.write`). „Abrechnungsreif“ ist gesperrt, solange eine
Behandlung ohne Unterschrift/Papier-Vermerk ist. Für Bestands-Verordnungen (Behandlungen vor dem Deploy) gibt es im
Leistungsnachweis den **Sammel-Vermerk „Unterschriften liegen auf Papier vor“** für alle offenen Behandlungen bis zu einem
Datum (bewusst bestätigt, Audit `record.signature_paper_bulk`) – **nur für Verordnungen ohne Pflicht zur Unterschrift je
Behandlung** (Übernahmen/Altbestand, `!signatureRequired`); bei Verordnungen nach aktuellem Regelwerk wird er abgelehnt und
nicht angeboten (dort je Behandlung unterschreiben bzw. einzeln den Papier-Vermerk setzen). Wird gleichzeitig eine
Unterschrift zur selben Behandlung erfasst, gewinnt diese (`ON CONFLICT DO NOTHING`, gleiche Sperrreihenfolge: erst
Verordnung, dann Unterschrift). Eine Unterschrift, die nicht am Behandlungstag erfolgte,
ist im Leistungsnachweis (Seite und PDF) als „nachgetragen“ markiert. App-Rolle ohne UPDATE/DELETE auf
`treatment_signatures` (scripts/migrate.ts); Unterschriften gehen in den Praxis-Export (`unterschriften/…`) und sind in
`scripts/archive-orphans.ts` bekannt.

**Leistungsnachweis-PDF** (`/api/verordnungen/<id>/leistungsnachweis`, Recht `medical.read`, im Support-Modus gesperrt,
`Cache-Control: private, no-store`, `nosniff`): Praxiskopf mit IK, Person, Kasse, Verordnung; Tabelle aller
Behandlungen mit Datum, Position(en) je Tag (Preis-Snapshot bzw. dieselbe Zuordnung wie im Snapshot), Einheiten und
Unterschrift als Bild bzw. Papier-Vermerk/„Unterschrift fehlt“. Zum Ausdruck und Beilegen.

**Zuzahlungsquittung.** „Zuzahlung quittieren“ an der Verordnung (Recht `invoices.write` – Kassenvorgang am Tresen)
erzeugt einen Beleg der neuen Art `copayment` (Nummernkreis **ZZ**, `invoices.prescription_id`), sofort ausgestellt und
bezahlt, im Beleg-Archiv. Positionen: 10-%-Anteil je Heilmittelposition + Verordnungsblattgebühr (aus dem Preis-Snapshot
bzw. der Schätzung mit erbrachten und noch offenen Einheiten), bei abweichendem Betrag eine Zeile mit Hinweis auf die
berechnete Zuzahlung. Kein USt-Ausweis; Hinweis „Gesetzliche Zuzahlung nach § 32 Abs. 2 i. V. m. § 61 SGB V …; Quittung
nach § 61 Satz 4 SGB V. Umsatzsteuerfrei nach § 4 Nr. 14 Buchst. a UStG.“ – gleich auf PDF und Browser-Ansicht, auch
für den Stornobeleg und bei Kleinunternehmer:innen. Ohne bekannten Preis/Positionsnummer: frei eingegebener Betrag (eine
Zeile „Zuzahlung laut Verordnung“, höchstens 10.000 €, Vermerk „Betrag manuell, Berechnung nicht möglich“) – das
Formular an der Verordnung erscheint dann mit Pflicht-Betragsfeld; Befreiung (Bescheinigung gilt heute) und Alter unter
18 (heute) werden wie im berechneten Fall geprüft; liegt die Summe der Quittungen über 200 € (Plausibilitätsgrenze), nur
mit ausdrücklicher Bestätigung. Die offene Zuzahlung zeigt die Akte mit derselben Berechnung wie beim Quittieren
(`copaymentDue`). Ein Betrag über der offenen Zuzahlung nur mit ausdrücklicher Bestätigung; Überweisung nur nach Zahlungseingang quittieren. Die Zahlung läuft über `applyPayments`: PodoHero-Kasse → TSE-Signatur, Tagesabschluss/Z-Bon,
DSFinV-K; eigene Praxiskasse → Vermerk mit Bon-Nr. (`register = 'external'`, Kassenvermerke). **Keine zweite Kasse.**
Erstattung (z. B. Überzahlung): „stornieren/erstatten“ → Stornobeleg mit negativer Zahlung über denselben Weg, danach den
richtigen Betrag neu quittieren – erst, wenn die Erstattung gebucht ist. Zuzahlungsquittungen zählen nicht als
„Leistung am Tag abgerechnet“ (`NOT_BILLING_KINDS`: Sammelrechnungs-Vorschlag, Jahresend-Erinnerung). Der CSV-Export „Zuzahlung erhalten am“ nimmt die letzte gültige Quittung, sonst den
Altvermerk. Der Stornobeleg einer Zuzahlungsquittung heißt „Storno zur Zuzahlungsquittung ZZ…“ (Datumshinweis „Leistungsdatum der
stornierten Zuzahlungsquittung“, Begleit-E-Mail „Storno Zuzahlungsquittung“).

**Buchhaltung:** Zuzahlungsquittungen **entweder** über lexoffice **oder** über den Kassenexport (DSFinV-K/Z-Bon) an
die Buchhaltung geben, nicht beides – sonst ist die Zuzahlung doppelt erfasst. Die Auszahlung des Abrechnungszentrums
enthält die Zuzahlung nicht (die Kasse zahlt Heilmittelkosten abzüglich Zuzahlung); sie wird netto als Kassenanteil
gebucht. Beides mit der Steuerberatung klären (siehe docs/KASSE.md, offener Punkt 15). **Eigene Praxiskasse**
(`register = 'external'`, Vermerk mit Bon-Nr.): Die Einnahme steht dann bereits im Z-Bon der Praxiskasse; der ZZ-Beleg
ist nur die Quittung für die Person und darf weder über lexoffice noch über den PodoHero-Kassenexport ein zweites Mal
an die Buchhaltung gemeldet werden (mit der Steuerberatung klären).

**Altvermerke** (`copayment_paid_at/_cents/_method` aus der Zeit vor Paket B) bleiben unverändert und **gelten als
erhalten**: Ihr Betrag (`copayment_paid_cents`, sonst der **zuletzt gespeicherte Rechenwert** `copayment_cents` der
Verordnung – nicht zwingend der Stand beim Vermerk) wird beim Quittieren angerechnet – gesperrt ist nur, wenn danach
nichts mehr offen ist; ein Restbetrag kann quittiert werden. Ohne Betrag und ohne Rechenwert über 0 (`copayment_cents`
leer oder 0) gilt die Zuzahlung bewusst als vollständig erhalten – so entsteht keine Quittung über bereits Erhaltenes;
das gilt auch ohne Preis (manueller Fall: kein Formular, nichts offen). Die Quittung nennt den Altvermerk gesondert:
„vermerkt: X € – angerechnet“ bzw. ohne Betrag „ohne Betrag vermerkt – angerechnet mit der in der Verordnung gespeicherten Zuzahlung X €“,
jeweils „ohne Beleg in PodoHero“. **„bereits quittiert“ meint nur Beträge mit ZZ-Beleg**; Hinweis auf der Quittung
(„bereits quittiert X €, Altvermerk Y €“), Akte („quittiert X € · Altvermerk Y €“) und Meldung („nichts mehr offen
(quittiert X €, Altvermerk Y €)“) weisen beides getrennt aus. Neue Altvermerke sind nicht möglich. Entfernen nur als
„Vermerk war falsch – nichts erhalten“ (Pflichtbegründung, Recht `invoices.write` + `medical.read`, Audit mit altem
Wert; ohne Vermerk: Meldung „kein Vermerk vorhanden“, kein Audit). Eine nachträgliche Quittung/Kassenbuchung für früher
erhaltene Beträge gibt es bewusst nicht – ob und wie diese Beträge nachzuerfassen sind, mit der Steuerberatung klären.

**Bekannter Prozessfall „Altvermerk nur teilweise richtig“:** Stimmt der Betrag eines Altvermerks nicht (z. B. weniger
erhalten als vermerkt), gibt es keine Korrektur des Betrags. Weg: „Vermerk war falsch – nichts erhalten“ mit Begründung
(alter Wert steht im Audit), danach den tatsächlich früher erhaltenen Betrag mit der Steuerberatung klären und den noch
offenen Rest regulär quittieren. Ein früher erhaltener Teilbetrag erscheint dann nicht mehr als Altvermerk in der Akte.

## Paket B Teil 2: Therapiebericht und Folgeverordnung

**Therapiebericht (Position 78530).** Je Verordnung ein Bericht (Befund, Verlauf, Ergebnis, Empfehlung, Freitext) unter
`/kunden/<id>/verordnungen/<vo>/therapiebericht`; anlegen/ändern mit `medical.write`, ansehen und PDF
(`/api/verordnungen/<id>/therapiebericht`: Praxiskopf mit Logo, Ärztin/Arzt mit LANR/BSNR, Person, Verordnung, Datum)
mit `medical.read`, im Support-Modus gesperrt. Steht 78530 auf der Verordnung (oder ist „Therapiebericht angefordert“
angekreuzt) und fehlt der Bericht → Hinweis „Therapiebericht fehlt“. Tabelle `therapy_reports` (Migration 0065):
höchstens ein Bericht je Verordnung, Berichtsdatum ein echtes Kalenderdatum und nicht vor dem ersten Behandlungstag, ab
„abrechnungsreif“/„abgerechnet“ nicht mehr änder- oder neu anlegbar (Trigger), nie löschbar (App-Rolle ohne DELETE) und –
als medizinische Dokumentation – Aufbewahrungsgrund gegen die vollständige Löschung der Person (`podo_delete_patient`,
`retentionFacts`). Steht 78530 auf der Verordnung und fehlt der Bericht, warnt „abrechnungsreif“ (keine Sperre). Audit ohne Inhalte. Versand bleibt manuell
(Download/Druck) – für die Ärztin/den Arzt ist keine E-Mail-Adresse gespeichert, daher kein E-Mail-Versand.

**78530 im Preis-Snapshot.** Der Bericht zählt als erbrachte Einheit 78530 mit dem **Berichtsdatum** (nicht mehr
verteilt auf die Behandlungstage): eine Zeile (Berichtsdatum, 78530, 1 Einheit), Preis an diesem Tag, `copayCents`
`null` (Anlage 2: keine Zuzahlung). Damit bleibt der Integrationsvertrag mit `src/lib/gkv302/adapter.ts` erhalten (je
(Tag, ZL-Nummer) genau eine Zeile). Ohne Bericht wird 78530 nicht angesetzt (Hinweis im Snapshot), mehr als eine
verordnete Einheit 78530 → Hinweis, angesetzt wird eine (`priceSnapshot`, `therapyReportDate`).

**Folgeverordnung.** Hinweis „Folgeverordnung anfordern“ an der neuesten Verordnung einer Person, wenn sie
abgeschlossen/abrechnungsreif/abgerechnet ist oder nach mindestens einer Behandlung nur noch ≤ 1 Einheit offen ist, UND
die Person weitere geplante Termine hat oder als **Dauerpatient:in** markiert ist (`patients.follow_up_expected`,
Schalter auf der Verordnungsseite), UND es keine neuere Verordnung gibt (`followUpReason`). Sichtbar in der Akte
(Patientenseite, Verordnungen) und auf „Heute“ (Karte „Folgeverordnung anfordern“, nur noch nicht angeforderte).
Vorlage „Anforderung Folgeverordnung“ als PDF bzw. Text (`/api/verordnungen/<id>/folgeverordnung[?format=text]`) mit
Diagnose/ICD, Heilmitteln, Behandlungszeitraum und – falls vorhanden – Verlauf/Ergebnis/Empfehlung aus dem
Therapiebericht. Vermerk „angefordert am“ (`follow_up_requests`, append-only, App-Rolle ohne UPDATE/DELETE; geht nur mit
der Person über `podo_delete_patient`, Prüfung `podo_owner_delete_allowed` wie 0019; Audit
`prescription.follow_up_requested`). „Frist überschritten“ nach mindestens einer Behandlung zählt als beendet. Die Karte
auf „Heute“ braucht `medical.read` und filtert in SQL auf Personen mit künftigen Terminen bzw. „Dauerpatient:in“.
Beim Planen: zuerst „gewählte Verordnung nicht mehr buchbar“, sonst Termin nach dem Ende der letzten Verordnung ohne neue
Verordnung (GKV-Versicherte) → Hinweis (ohne `medical.read` ohne Datumsangaben); Termine über die Restmenge hinaus →
Erinnerung an die Folgeverordnung.

## Offene Punkte (fachlich prüfen)

1. **Werktage** in Vertrag § 7 Abs. 6: PodoHero zählt Montag–Samstag ohne Feiertage (eher streng). Ob Samstage und
   Feiertage zählen, bitte mit dem Verband/Abrechnungszentrum klären.
2. **Zuordnung der Positionen zu Behandlungstagen**: PodoHero erfasst je Behandlung nicht, welche Position abgegeben
   wurde, und ordnet die Einheiten je Position in zeitlicher Reihenfolge zu (je Tag eine Einheit jeder Position). Für
   Verordnungen mit Befundungs-/Hausbesuchspositionen kann das vom tatsächlichen Ablauf abweichen.
3. **Rundung der Zuzahlung**: verwendet wird der nachrichtliche Betrag je Position aus Anlage 2 (10 %, kaufmännisch
   gerundet, je Einheit). Ob Abrechnungszentren auf die Summe runden, ist nicht belegt.
4. **LANR-Ersatzwerte** (z. B. Krankenhaus-/Vertretungsnummern) folgen nicht zwingend der Prüfziffer – deshalb nur Hinweis.
5. **BSNR-Prüfziffer**: in den gelesenen Quellen nicht festgelegt.
6. **DF-ICD-Liste** ist nicht abschließend (z. B. G99.0* autonome Neuropathie) – andere Codes nur „bitte prüfen“. NF/QF ohne
   belegte Liste.
7. **Leitsymptomatik UI2**: Anlage 3 Buchst. l nennt „UII = b)“, der Heilmittelkatalog führt für UI 2 nur „a)“. Korrekturen
   sind laut Anlage 3 bei UI nicht erforderlich – PodoHero prüft die Leitsymptomatik bei UI daher nicht.
8. **Preise vor dem 01.07.2025** sind nicht hinterlegt (Snapshot meldet „kein Preis“).
9. **Entlassmanagement** (Beginn innerhalb 7 Tagen nach Entlassung, Vertrag § 6 Abs. 3 / § 7 Abs. 4) ist noch nicht
   abgebildet (kein Feld auf der Verordnung).
10. **UI-Begründungsfeld** (Lokalisation des Zehs, Anlage 3 Buchst. o2) ist noch nicht abgebildet. Das Bestätigungsfeld
    (Unterschrift je Behandlung, Buchst. o) ist seit Paket B umgesetzt.
11. Kalender-Badge „VO“ am Termin: noch nicht umgesetzt (optional).
12. **Pauschale bei 18. Geburtstag im Behandlungszeitraum**: Ist die 10-€-Verordnungsblattgebühr fällig, wenn die Person
    erst nach dem ersten Termin 18 wird? Aktuell ist der erste Behandlungstag maßgeblich (Vertrag § 8 Abs. 2 Satz 3).
13. **Wiederaufnahme aus „Frist überschritten“**: PodoHero erlaubt sie mit Begründung (z. B. Beginn rechtzeitig, aber nicht
    erfasst) und zählt die 12-Wochen-Frist ab der Wiederaufnahme. Ob Kassen das so akzeptieren, ist nicht belegt – die
    Verantwortung liegt bei der Praxis; bitte mit dem Abrechnungszentrum klären.
14. **Übernahmen mit Status „in Behandlung“** (Import-Altbestand): Beginnfrist gilt als eingehalten; ohne erfassten
    Behandlungstag zählt die 12-Wochen-Unterbrechung ab dem **Importdatum** (die Termine im Altsystem sind nicht bekannt).
    Ob dieser Fristbeginn fachlich trägt, bitte mit dem Abrechnungszentrum klären.
15. **Storno/Korrektur eines Abrechnungslaufs**: abgerechnete Verordnungen sind gesperrt; seit Paket C gibt es einen
    internen Korrekturweg (Korrekturvermerk, Neuabrechnung im nächsten Lauf, siehe Paket C). Weiter offen: Annahme durch
    Abrechnungszentrum/Kasse (Fachfrage 33) und das Korrekturverfahren § 302.
16. **Pflegeheim-Praxen**: Bei Besuchstagen im festen Rhythmus (z. B. alle 3 Wochen) kann die verordnete Frequenz
    (DF/NF/QF: alle 4–6 Wochen) unterschritten werden – dann ist je Behandlung eine Begründung (Absprache mit der Ärztin/dem
    Arzt) Pflicht. Ob eine einmalige Absprache für die ganze Verordnung genügt, ist nicht belegt.
17. **78610-Verteilung**: Wie viele 78610 an welchem Tag abgegeben wurden, erfasst PodoHero nicht; der Snapshot verteilt
    (höchstens 2 je Tag, Anlage 2 § 2 Abs. 2 Buchst. c).
18. **Zwei Einheiten am selben Tag**: Zwei Behandlungseinträge am selben Tag für dieselbe Position werden im Snapshot
    angesetzt und nur als Hinweis markiert – ist das abrechenbar?
19. **78610 zweimal täglich ohne Einzelnachweis**: Der Snapshot nimmt „2 × am Tag“ an, wenn die verordneten Einheiten
    sonst nicht auf die Behandlungstage passen. Akzeptieren Kassen das ohne Einzelnachweis in der Doku?
20. **Azubis mit `medical.write`** dürfen „Wiederaufnahme“ setzen – Produktentscheidung offen (ggf. eigene Berechtigung).
    „Zuzahlung quittieren“ verlangt seit Paket B `invoices.write` (Kassenvorgang); der Empfang (ohne `medical.read`)
    erreicht die Verordnungsseite aber nicht – Zuzahlung am Tresen durch den Empfang bitte als Produktfrage klären.
21. **CSV-Werte „minderjährig“/„gemischt (…)“** in der Spalte „Zuzahlungsbefreit“ vor der ersten Übergabe mit dem
    Abrechnungszentrum abstimmen.
22. **Unterschrift elektronisch statt auf dem Papier-Formular**: Ob Kassen/Abrechnungszentren die auf dem Gerät erfasste
    Unterschrift mit dem ausgedruckten Leistungsnachweis als Bestätigung nach Anlage 3 Buchst. o akzeptieren, ist nicht
    belegt (Anlage 3 nennt das Feld auf der Verordnung). Bitte mit dem Abrechnungszentrum klären.
23. **Mehrere Behandlungseinträge am selben Tag**: Unterschrift wird je Eintrag verlangt; ob eine Unterschrift je Tag genügt,
    ist nicht belegt.
24. **Zuzahlungsquittung im DSFinV-K**: als „Umsatz“ mit USt-Schlüssel „umsatzsteuerfrei“ gemeldet (wie andere Heilbehandlungen);
    ob Zuzahlungen eine andere Geschäftsvorfall-Art brauchen, mit Steuerberatung/TSE-Anbieter klären (docs/KASSE.md).
25. **Zuzahlung vorab für die ganze Verordnung**: Die Schätzung nimmt für noch offene Einheiten gedachte Folgetage ab heute
    an (Preisstand heute, Alter am gedachten Tag). Ändert sich der Preisstand (z. B. 01.07.) vor der nächsten Behandlung,
    weicht der Snapshot bei Abrechnungsreife ab → Hinweis „Restbetrag offen“ bzw. Überzahlung (Erstattung).
26. **Therapiebericht bei anderen Diagnosegruppen**: 78530 ist laut Anlage 2 der „Therapiebericht UI 2“. Für DF/NF/QF
    erstellt PodoHero den Bericht auf Anforderung (Kreuz „Therapiebericht“), setzt aber nur 78530 an, wenn die Position auf
    der Verordnung steht – ob dafür eine andere Vergütung gilt, bitte prüfen.
27. **Berichtsdatum außerhalb der Behandlungstage**: 78530 wird mit dem Berichtsdatum abgerechnet, auch wenn an diesem Tag
    keine Behandlung war. Ob Abrechnungszentren das so erwarten (oder am letzten Behandlungstag), klären.
28. **Folgeverordnung**: Der Hinweis ist eine Praxis-Erinnerung ohne vertragliche Frist; Kriterien (≤ 1 Einheit, Termine,
    Dauerpatient:in) sind eine Produktentscheidung.

## Paket C: Verordnungsart, Absetzungen und Korrektur (PR „GKV Paket C“)

Quelle für die Schlüssel: GKV-Spitzenverband, Richtlinien nach § 302 SGB V, **Anlage 3 „Schlüsselverzeichnisse“ Version
21** (Stand 19.09.2025, anzuwenden ab 01.10.2025), 8.1.11 (S. 27), 8.1.12 (S. 28), 8.1.17 (S. 35) –
https://www.gkv-datenaustausch.de/media/dokumente/leistungserbringer_1/sonstige_leistungserbringer/technische_anlagen_aktuell_4/Anlage_3_TP5_V21_20250919.pdf
(gelesen am 18.11.2026, Text extrahiert). Code: `src/lib/rules/gkv-billing.ts`, `src/server/gkv-billing.ts`, Migration
`0066_gkv_paket_c.sql`.

| Regel | Wert | Quelle | Code |
|---|---|---|---|
| Kennzeichen Verordnungsart | „03“ Verordnung nach § 7 Abs. 1–5 HeilM-RL (orientierende Behandlungsmenge), „04“ nach § 7 Abs. 6 HeilM-RL (besonderer Verordnungsbedarf oder langfristiger Heilmittelbedarf); „05“ (Blankoverordnung, § 13a HeilM-RL) **nicht für Podologie** – nicht wählbar, DB-CHECK nur 03/04 | Anlage 3 V21 8.1.12 | `PRESCRIPTION_KINDS`, `prescriptions_prescription_kind_check` |
| Bestätigung | nie vorbelegt, nie geraten: die bewusste Auswahl an der Verordnung („Abrechnungsangaben“) ist die Bestätigung; gespeichert mit Person und Zeitpunkt (`prescription_kind_confirmed_by/_at`); Bestand = NULL = nicht bestätigt | Aufgabe Paket C; GKV-302.md B2 | `saveBillingDetails` |
| Vorschlag | nur aus belegten Daten: erfasste Genehmigung (B2) → Hinweis „Vorschlag 04“. Die Diagnoselisten für besonderen Verordnungsbedarf (BVB) bzw. langfristigen Heilmittelbedarf (Anlage 2 HeilM-RL) sind in PodoHero **nicht** hinterlegt → sonst „bitte wählen“ | Anlage 3 V21 8.1.17 (B2 = § 8 Abs. 3 HeilM-RL) | `suggestPrescriptionKind` |
| Sperre | ohne bestätigtes Kennzeichen: kein „abrechnungsreif“, kein Abrechnungslauf (auch Bestand „abrechnungsreif“), kein Fall „ok“ im § 302-Prüflauf (fehlende Angabe; der Server liefert nur das bestätigte Feld – nie „03“) | Aufgabe Paket C; TA1 ZHE Muss-Feld | `changePrescriptionStatus`, `createBillingBatch`, `gkv302-export.ts` |
| Verordnungsbesonderheit | 1 Zahnarzt/Kieferorthopäde, 2 Schwangerschaft/Entbindung, 4 Entlassmanagement, 7 Terminservicestelle, 9 Modellvorhaben § 64d SGB V („3“ nicht belegt, „8“ nur Hilfsmittel) | Anlage 3 V21 8.1.11 | `PRESCRIPTION_SPECIALS`, ZHE |
| Genehmigung | Genehmigungskennzeichen (höchstens 20 Zeichen, Buchstaben/Ziffern/. - /) und Datum, Art „B2“ (Genehmigung eines langfristigen Heilmittelbedarfs); beides oder nichts | Anlage 3 V21 8.1.17; TA1 SKZ | `approval_ref/_date`, SKZ |
| Abrechnungslauf-CSV | neue Spalten am Ende: Verordnungsart, Verordnungsbesonderheit, Genehmigung Kennzeichen/Datum, Korrektur | – | `GKV_BATCH_HEADER` |

**Absetzungen/Retaxen** (`gkv_deductions`): an der abgerechneten Verordnung in der Akte erfassen (Betrag, Datum, Code
optional, Grund – ohne Gesundheitsangaben formulieren), Recht **Rechnungen schreiben + medizinisch lesen** (wie
Abrechnungslauf), `gkvGuard("gkvBilling")`. Der Abrechnungslauf wird aus der Verordnung übernommen. Status offen →
Widerspruch/akzeptiert → erledigt (abschließend; Widerspruch kann wieder „offen“ werden). Optional Aktenzeichen und Datum
des Kassenschreibens (`letter_ref`, `letter_date`). Beim Wechsel auf **erledigt** ist der **Ausgang** Pflicht (`outcome`:
`upheld` = Absetzung bleibt, `reversed` = Widerspruch erfolgreich; DB-CHECK `gkv_deductions_outcome_check`:
erledigt ⇔ Ausgang gesetzt) – nur so lässt sich später unterscheiden, ob die Absetzung den Kassenbetrag tatsächlich
mindert. Betrag/Grund/Datum nur bei
„offen“ änderbar (Fehleingabe), Bezug unveränderlich, **nie löschbar** (App-Rolle ohne DELETE, Trigger; Löschen nur mit der
Person über `podo_owner_delete_allowed` – `podo_delete_patient` verweigert aber, solange eine Absetzung existiert).
Auswertung offener Absetzungen: **Verordnungen → GKV-Abrechnung → Absetzungen** (`/verordnungen/absetzungen`: offen,
Widerspruch, akzeptiert, Summe des Jahres; Filter; Status/Notiz/Kassenschreiben/Ausgang pflegen; nur mit
Kassenabrechnung – `requireFeature`/`gkvGuard("gkvBilling")` auch beim Lesen). Audit ohne Grund/Notiz (Ausgang und
„Kassenschreiben geändert“ ja, ohne Aktenzeichen).

**Korrektur abgerechneter Verordnungen** (`prescription_corrections`, Status `correction_needed` „Korrektur nötig“):
Eine abgerechnete Verordnung bleibt unveränderbar (`prescriptions_billed_lock`). Einziger Weg: „Korrektur nötig …“ mit
Begründung (optional Bezug auf eine Absetzung). Dabei entsteht ein **Korrekturvermerk mit dem Stand der Erstabrechnung**
(Lauf, Zeitpunkt, Heilmittelkosten, Zuzahlung, Preis-Snapshot und die **vollständige Verordnungszeile** `original_row`
– vom Trigger aus der abgerechneten Zeile gesetzt, nie aus der Anwendung, unveränderlich); der Trigger erlaubt aus
„abgerechnet“ nur diesen Statuswechsel und nur mit offenem Vermerk. Danach ist die Verordnung bearbeitbar (Formular
„Bearbeiten“, Abrechnungsangaben, Therapiebericht; Regelwerk und Zuzahlung der Erstabrechnung bleiben bis zum neuen
Snapshot; Audit `prescription.update` bzw. `prescription.billing_details` mit `correction: true` und **`changedFields`** –
Liste der geänderten Spaltennamen, keine Werte), wird erneut „abrechnungsreif“ (neuer Preis-Snapshot, alle Prüfungen;
**Hinweis**, wenn sich das Zuzahlungs-Soll gegenüber der Erstabrechnung oder den schon quittierten Beträgen ändert – keine
Sperre) und geht in den **nächsten Abrechnungslauf**; dort wird der Vermerk als „erneut abgerechnet“ (mit neuem Lauf)
abgeschlossen – der Trigger prüft, dass dieser Lauf die Verordnung enthält und **nicht** der Lauf der Erstabrechnung ist.
Hat eine Verordnung Korrekturvermerke, lässt `podo_prescription_billed_lock` „abrechnungsreif“ → „abgerechnet“ nur mit
einem **neuen Lauf** zu (vorhanden, nicht der Lauf einer Erstabrechnung, angelegt nicht vor dem jüngsten Vermerk – AppSec
Runde 2). Den Stand der Erstabrechnung im Vermerk (Lauf, Zeitpunkt, Beträge, Preis-Snapshot, `original_row`) und dessen
Anlagezeitpunkt setzt immer der Trigger, nie die Anwendung. Abrechnungsläufe sind nie löschbar, ihr Anlagezeitpunkt kommt
vom Server und ist unveränderlich (`podo_billing_batch_guard`); nach dem Anlegen bleibt ein Lauf unverändert (Summen,
Anzahl, Partner, Notiz), nur die Übergabe wird einmalig vermerkt (`exported_at` NULL → Zeitpunkt, Status „draft“ →
„exported“). „Abgerechnet“ (aus „abrechnungsreif“, mit oder ohne Korrektur) setzt der Trigger nur in einen Lauf, der im
selben Vorgang angelegt und noch nicht übergeben ist – wie im Abrechnungslauf (AppSec Runde 3); ebenso muss der Lauf
eines Vermerks „erneut abgerechnet“ im selben Vorgang angelegt sein. Der Lauf an einer Verordnung (`billing_batch_id`)
ändert sich nur bei diesem Wechsel; eine neue Verordnung (INSERT) bekommt nur NULL oder einen eben angelegten, nicht
übergebenen Lauf. Ein neuer Lauf ist immer Entwurf ohne Übergabe; die Übergabe setzt Status und Zeitpunkt (vom Server)
gemeinsam. CSV- und § 302-Export eines Laufs nehmen nur abgerechnete Verordnungen des Laufs (plus Korrekturen mit dem
Stand der Erstabrechnung) – AppSec Runde 4. **Laufsummen = Summe der Verordnungen** (Migration 0067, Restrisiko R2 aus
dem AppSec-Review Paket C – **behoben**): Verordnungen kommen nur im Vorgang in einen Lauf, in dem er angelegt wird
(0066), und ihre Beträge sind danach eingefroren – deshalb prüfen aufgeschobene CONSTRAINT TRIGGER genau dort beim Commit:
beim Anlegen des Laufs (`billing_batches_sum_check`) **und** bei jeder Verordnung, die in diesem Vorgang in den Lauf kommt
oder darin Status/Beträge ändert (`prescriptions_batch_sum_check_insert`/`_update`). Ein vorgezogenes `SET CONSTRAINTS
… IMMEDIATE` umgeht das nicht mehr (AppSec K1, PR #122); ein vor dem Commit geleerter oder auf eine fremde Praxis
gesetzter Praxis-Kontext (`app.org_id`) führt zur Ablehnung statt zu einer leeren Prüfung (K1-R2). Regeln: mindestens eine Verordnung, alle Verordnungen mit dem Lauf
„abgerechnet“ oder „Korrektur nötig“ (bleibt Teil des Laufs, zählt mit), Anzahl, `total_cents` = `copayment_total_cents` =
Summe der Zuzahlungen, `remedy_total_cents` = Summe der Heilmittelkosten (fehlende Beträge zählen 0, wie
`createBillingBatch`). Läufe aus früheren Vorgängen (Altläufe vor 0067, Übergabe, spätere Korrektur und Neuabrechnung in
einem neuen Lauf) prüft der Trigger nicht. Abgerechnete Verordnungen (`billed_at` oder Lauf gesetzt) sind nicht löschbar
(`prescriptions_delete_guard`, 0067) – außer im Löschlauf der Person, den `podo_delete_patient` bei abgerechneten
Verordnungen ohnehin verweigert; vor der Prüfung sperrt sie die Verordnungen der Person (gleichzeitige Abrechnung wird
abgewartet). **Löschfreigabe** (AppSec K2): `podo_owner_delete_allowed` verlangt seit 0067 zusätzlich einen Eintrag von
`podo_delete_patient` in `podo_private.delete_grants` für die laufende Transaktion – das Kennzeichen
`podo.patient_delete` allein (setzbar von jeder Sitzung) reicht nicht mehr; die App-Rolle hat kein DELETE auf `patients`
und `organizations` (scripts/migrate.ts). Ein zweiter gleichzeitiger Export eines Laufs ändert nichts mehr (erster
Übergabezeitpunkt bleibt). Beim Setzen von „Korrektur nötig“ schlägt das Formular eine noch nicht verknüpfte Absetzung als
Bezug vor (dann gilt sie bei Neuabrechnung als „ersetzt“). Solange der Vermerk offen ist, geht es aus „abrechnungsreif“
auch zurück nach „Korrektur nötig“ (Trigger: „Korrektur nötig“ nur mit offenem Vermerk).

„**Ohne Neuabrechnung abschließen**“ (z. B. Absetzung akzeptiert, Begründung Pflicht) → wieder „abgerechnet“ im
ursprünglichen Lauf – **nur, wenn die Verordnung inhaltlich unverändert ist** (Vergleich mit `original_row` ohne Status,
Altvermerk Zuzahlung und ohne die abgeleiteten Beträge Preis-Snapshot, Heilmittelkosten, Zuzahlung – diese werden aus der
Erstabrechnung wiederhergestellt). Eine Neubestätigung des Kennzeichens im Korrekturstatus (auch mit gleichem Wert) zählt
als Änderung und erzwingt die Neuabrechnung; das Formular weist darauf hin – bei Altbestand ohne bestätigtes Kennzeichen
heißt das: entweder ohne Neuabrechnung abschließen (nichts speichern) oder bestätigen und neu abrechnen. Sonst Fehler „Geänderte Verordnung
muss neu abgerechnet werden“. Der Trigger `podo_prescription_billed_lock` erzwingt dasselbe: „Korrektur nötig“ →
„abgerechnet“ nur, wenn der jüngste Vermerk im selben Vorgang als `no_rebill` abgeschlossen wurde, keiner mehr offen ist und
die Zeile (ohne die genannten Felder außer den abgeleiteten Beträgen) `original_row` entspricht. Damit gibt es keine stille
Änderung im alten Lauf. Umgekehrt prüft ein Constraint-Trigger beim Commit, dass ein als `no_rebill` abgeschlossener Vermerk
nur zusammen mit der Rückkehr auf „abgerechnet“ im Lauf der Erstabrechnung gespeichert wird.

Abgeschlossene Vermerke sind unveränderlich, nie löschbar. Der **CSV-Export des ursprünglichen Laufs** führt die
Verordnung weiter (Spalte „Korrektur“: offen / in späterem Lauf neu abgerechnet / ohne Neuabrechnung) – **mit dem Stand
der Erstabrechnung** aus `original_row` (reproduzierbar, Zeilensumme = Laufsumme); der neue Lauf mit den korrigierten
Werten und „Neuabrechnung nach Korrektur vom …“. Ebenso der **§ 302-Prüflauf/Testpaket „Abrechnungslauf“**: der alte Lauf
mit dem Originalstand (je Verordnung einmal), die korrigierte Fassung nur unter „bereit“ bzw. im Lauf der Neuabrechnung.
Die Versichertennummer kommt aus der Verordnung (Stand der Abrechnung bzw. `original_row`), nur bei Altbestand ohne Angabe
an der Verordnung aus der Person; Name, Anschrift und Krankenkassenname kommen weiter aus der aktuellen Akte. Absetzungen und Korrekturvermerke sind Aufbewahrungsgründe
(`retentionFacts`, `podo_delete_patient`), gehen in den Praxis-Export (`tables/gkv_deductions.json`,
`tables/prescription_corrections.json`) und haben keine Dateien (archive-orphans unverändert).

Offener Punkt 15 (Storno/Korrektur eines Abrechnungslaufs) bleibt **offen**: PodoHero bietet einen internen,
nachvollziehbaren Korrekturweg (Vermerk, Neuabrechnung im nächsten Lauf), aber ob das Abrechnungszentrum bzw. die Kasse
eine Neuabrechnung so annimmt, ist nicht geklärt (Fachfrage 33); das Korrekturverfahren § 302 (VKZ 02–04 mit URI-Daten)
folgt mit dem Echtbetrieb der Direktabrechnung (docs/GKV-302.md).

### Offene Fachfragen Paket C (Abrechnungszentrum/Steuerberatung)

29. **Kennzeichen 03/04 bei Altbestand**: Für Verordnungen vor Paket C muss die Praxis das Kennzeichen nachträglich vom
    Papier ablesen. Ist das für schon an das Abrechnungszentrum übergebene Verordnungen nötig, oder ergänzt das
    Abrechnungszentrum es selbst? (Abrechnungszentrum)
30. **BVB-/LHB-Diagnoselisten**: Sollen die Listen (Anlage 2 HeilM-RL, KBV/GKV-Liste besonderer Verordnungsbedarf) für
    Podologie hinterlegt werden, um „04“ vorzuschlagen? Quelle und Pflege (jährliche Änderung) klären.
31. **Verordnungsbesonderheit 1/9**: Zahnärztliche Verordnungen und Modellvorhaben § 64d gibt es für Podologie
    vermutlich nicht – trotzdem angeboten, weil Anlage 3 sie nicht einschränkt. Ausblenden? (Verband)
32. **Absetzung buchen**: Wie wird eine akzeptierte Absetzung gebucht (Forderungsausfall gegen Kassenforderung, Konto,
    Zeitpunkt)? PodoHero erfasst sie nur intern, keine Buchung/lexoffice. (Steuerberatung)
33. **Neuabrechnung nach Korrektur**: Rechnet das Abrechnungszentrum eine korrigierte Verordnung als neue Verordnung im
    nächsten Lauf ab (heute PodoHero-Weg), oder braucht es eine Kennzeichnung als Nachberechnung/Korrektur? Wie wird eine
    bereits gezahlte Teilsumme verrechnet? (Abrechnungszentrum)
34. **Aufbewahrung der Absetzungsschreiben**: Die Mitteilung der Kasse (Papier/PDF) ist Buchungsbeleg – soll sie als
    Datei an der Absetzung abgelegt werden? (Steuerberatung)
35. **Verordnungsart vor Behandlungsbeginn**: Soll das Kennzeichen schon beim Anlegen Pflicht sein (heute erst vor der
    Abrechnungsreife, damit Übernahmen/Bestand nicht blockieren)? (Produktentscheidung)
36. **Ausgang einer erledigten Absetzung**: Reichen „Absetzung bleibt“/„Widerspruch erfolgreich“, oder braucht es einen
    Teilerfolg (Teilbetrag erstattet)? Heute: Teilerfolg = Betrag vor „erledigt“ korrigieren geht nur bei „offen“ –
    sonst Notiz. (Abrechnungszentrum/Steuerberatung)
37. **Sicherung der Erstabrechnung**: `original_row` hält die Verordnungszeile beim Öffnen der Korrektur fest (die
    Versichertennummer der Verordnung ist darin enthalten und wird im CSV des alten Laufs verwendet); Personenangaben
    (Name, Anschrift, Krankenkassenname) sind nicht mitgesichert. Ebenfalls **nicht** eingefroren sind die
    **Behandlungstage** (Spalten „Erbrachte Einheiten“/„Behandlungstage“, aus den Behandlungen gelesen) und „**Zuzahlung
    erhalten am**“ (letzte gültige Zuzahlungsquittung, Storno/neue Quittung wirkt auch im alten Lauf). Ein erneuter Export
    des alten Laufs kann daher in diesen Spalten vom damals übergebenen abweichen. Reicht das für die Nachvollziehbarkeit,
    oder soll mehr gesichert werden? (Datenschutz/Steuerberatung)
    **Folgeaufgabe (Vorschlag)**: die erzeugte Exportdatei (CSV bzw. § 302-Paket) beim ersten Export mit SHA-256-Prüfsumme
    archivieren (wie das Beleg-Archiv), damit genau die übergebene Fassung belegbar bleibt. **Umgesetzt in Paket E**
    (Archiv des Übergabepakets mit SHA-256, Nachdruck byte-gleich); offen bleibt die Frage für Altläufe (Fachfrage 48).

### Paket C Teil 2: Auswertung Kasse vs. privat und Belegliste

**Auswertung → „Kasse vs. privat“** (`/auswertung/kasse`, Recht `finance.read` wie die übrige Auswertung, nur Summen,
Zeitraumfilter wie „Termine“/„Leistungen“, CSV je Monat außer im Support-Modus; `src/server/gkv-stats.ts`). Gezeigt wird
das **Abrechnungsvolumen** Kasse vs. privat – **kein Umsatz/Erlös** im Sinne der Buchhaltung: Läufe zählen nach
Erstellungstag (Soll), Quittungen und Privatbelege nach Belegdatum (Ist); Soll und Ist sind gemischt. **Stand Abruf**:
Stornos und Korrekturen wirken rückwirkend auf frühere Zeiträume (Hinweis auf der Seite).

- **GKV-Kassenanteil** = Heilmittelkosten − Zuzahlungen laut Abrechnungsläufen (gespeicherte Summen in
  `billing_batches`) nach dem Erstellungstag des Laufs – die Forderung an die Kassen, nicht der Zahlungseingang. Läufe ohne
  gespeicherte Heilmittelkosten (vor dem Preis-Snapshot) werden gezählt, aber nicht summiert (Hinweis).
- **Keine Doppelzählung bei Neuabrechnung**: Eine nach Korrektur neu abgerechnete Verordnung steht im alten und im neuen
  Lauf (die Laufsummen bleiben unverändert). Abgezogen wird die Zeile **„− ersetzt durch Neuabrechnung“** =
  Heilmittelkosten − Zuzahlung der Erstabrechnung (`original_remedy_cost_cents`/`original_copayment_cents` der
  Korrekturvermerke mit `resolution = 'rebilled'`), im **Monat des neuen Laufs** (`resolved_batch_id`). Über beide Läufe
  zählt die Verordnung damit genau einmal (mit dem neuen Stand); in einem Zeitraum nur mit dem neuen Lauf erscheint die
  Differenz. Nur, wenn der alte Lauf Heilmittelkosten gespeichert hat – dieselbe Bedingung gilt in der Belegliste.
  `original_*` setzt der Trigger aus derselben Verordnungszeile wie `original_row` (Export des alten Laufs): Auswertung,
  Belegliste und Export rechnen mit demselben Stand der Erstabrechnung. **Ein Monat kann negativ werden**, wenn der Abzug
  im Monat des neuen Laufs größer ist als dessen Läufe (Hinweis auf der Seite).
- **Zuzahlungen (ZZ)** getrennt: Zuzahlungsquittungen nach Belegdatum, ohne stornierte.
- **Privat (Belege brutto)**: alle übrigen Belege nach Belegdatum mit derselben Auswahl wie „Leistungen & Produkte“
  (`countedInvoiceSql`: ohne Entwürfe, Stornos, Gutschriften, Anzahlungen, angerechnete Quittungen).
- **Absetzungen** nach Datum der Absetzung: als **Minderung** nur „akzeptiert“ und „erledigt – Absetzung bleibt“;
  „offen“/„Widerspruch“ und „erledigt – Widerspruch erfolgreich“ getrennt (keine Minderung). Eine Absetzung, die über
  `deduction_id` an einem neu abgerechneten Korrekturvermerk hängt, ist **„durch Neuabrechnung ersetzt“** (getrennt
  ausgewiesen, keine Minderung, unabhängig vom Status) – die Erstabrechnung ist schon als „ersetzt durch Neuabrechnung“
  abgezogen, sonst zählte sie doppelt. Es gilt dieselbe Bedingung wie beim Abzug (alter Lauf mit Heilmittelkosten); sonst
  bleibt sie Minderung. Die Minderung wird nicht automatisch vom Kassenanteil abgezogen (Fachfrage 39).

**Auswertung → „Belegliste“** (`/auswertung/belegliste`, Rechte `finance.read` + `invoices.read`; CSV
`/api/export/belegliste?von=&bis=`, im Support-Modus gesperrt, Formel-Injection neutralisiert – reine negative Beträge
wie „-12,50“ bleiben Zahlen –, `no-store`): **interne Hilfsliste, keine Buchungsgrundlage** (maßgeblich sind die Belege
und die Sammelbelege des Abrechnungszentrums). Inhalt: Zuzahlungsquittungen (ZZ) mit Stornobelegen (Bezug in beide
Richtungen, Zahlungsart, Person mit Nummer – **kein Datum der Verordnung, keine Diagnosen**: Datenminimierung,
Art. 9 DSGVO) und die Abrechnungsläufe (lesbar „Lauf <Nr.> vom <Datum>“, laufende Nummer der Praxis statt UUID – stabil,
weil Läufe nie löschbar sind und ihr Anlagezeitpunkt vom Server kommt und unveränderlich ist, `podo_billing_batch_guard`.
Einschränkung: created_at ist der Beginn der Transaktion – überschneiden sich zwei Abrechnungsläufe zeitlich, kann ein
später sichtbar werdender Lauf vor einen schon gezeigten rücken und dessen Nummer verschieben (sehr selten);
Partner, Verordnungen, Heilmittelkosten, Zuzahlungen, Kassenanteil, Export). Die Spalte „Bezug“ kennzeichnet bei Läufen
nur den Korrekturbezug („N Verordnung(en) später neu abgerechnet (Kassenanteil … ersetzt)“ bzw. „enthält N
Neuabrechnung(en) nach Korrektur“, solange dieser Lauf nicht exportiert ist mit „– noch nicht übergeben“) – keine Notiz
(Freitext). Audit `stats.gkv_private` bzw. `belegliste.read` nur mit
Zeitraum und Anzahlen.

Offene Fachfragen (Steuerberatung):

38. **Abgrenzung Kassenanteil**: Erstellungstag des Laufs (Forderung) oder Zahlungseingang des Abrechnungszentrums
    (Zuflussprinzip wie „Finanzen“)? Seit Paket E werden Auszahlungen erfasst und als „Zahlungseingang
    Abrechnungszentrum“ neben dem Soll gezeigt (nicht verrechnet) – Abgrenzung weiter offen (Fachfrage 47).
39. **Absetzungen in der Auswertung**: Sollen akzeptierte/erledigte Absetzungen den Kassenanteil mindern, und in
    welchem Monat (Absetzungsdatum oder Lauf)? Heute zählen Absetzungen, deren Verordnung nach Korrektur neu abgerechnet
    wurde (Bezug über den Korrekturvermerk), nicht als Minderung, sondern als „durch Neuabrechnung ersetzt“ – stimmt das
    mit der Verrechnung durch Abrechnungszentrum/Kasse überein (Gutschrift der Absetzung vs. Neuabrechnung in voller
    Höhe)? Und ist ein negativer Monatswert (Abzug der Erstabrechnung im Monat des neuen Laufs) so akzeptabel?
40. **Belegliste als Buchungsgrundlage**: Die Belegliste ist eine Hilfsliste, keine Buchungsgrundlage. Reicht sie der
    Steuerberatung als Übersicht, oder werden die Sammelbelege des Abrechnungszentrums zusätzlich benötigt? Doppelte
    Erfassung der ZZ (Kassenexport/lexoffice) vermeiden (siehe Paket B „Buchhaltung“).
41. **Doppelzählung bei Neuabrechnung**: Heute wird die Erstabrechnung im Monat des neuen Laufs abgezogen (Laufsummen
    bleiben unverändert, reproduzierbar). Alternative: alten Monat rückwirkend mindern. Welche Abgrenzung erwartet die
    Steuerberatung, und wie bucht das Abrechnungszentrum Gutschrift/Nachberechnung? (Steuerberatung/Abrechnungszentrum)

## Paket E: Neutrale Übergabe an ein Abrechnungszentrum (PR „GKV Paket E“)

Entscheidung: **erstmal neutral** – kein festes Abrechnungszentrum (weder DMRZ, opta data noch Noventi). PodoHero erzeugt
je Abrechnungslauf ein neutrales Übergabepaket und liest die Rückmeldung des Zentrums wieder ein. Das Format (Felder,
Typen, Beispiele) steht vollständig in **docs/GKV-ABRECHNUNGSZENTRUM.md**. Code: `src/lib/gkv-handover/*`,
`src/server/gkv-handover.ts`, Seite `/verordnungen/abrechnung/<lauf>`, Migration `0068_gkv_paket_e.sql`.

- **Übergabepaket (ZIP)** je Lauf: `verordnungen.csv` (bisherige 43 Spalten + Status, Personennummer, Kassenanteil,
  Zuzahlung 10 %/Verordnungsblattgebühr, Therapiebericht-Datum, fehlende Unterschriften, Dateien), `behandlungen.csv`
  (je Behandlungstag und Position aus dem Preis-Snapshot, mit Unterschrift), `abrechnungslauf.json`
  (`podohero-abrechnung/1`, Cent-Beträge), `begleitzettel.pdf` (Summen und Liste, ohne Diagnosen), Leistungsnachweise und
  Therapieberichte als PDF (nur Verordnungen des Laufs; korrigierte mit dem Stand der Erstabrechnung), `PRUEFSUMMEN.sha256`,
  `LIESMICH.txt`. CSV: UTF-8 mit BOM, Semikolon, Formel-Injection entschärft (`writeCsv`). Rechte wie der
  Abrechnungslauf (`invoices.write` + `medical.read`, `gkvGuard("gkvBilling")`), Support-Modus gesperrt
  (`downloadAllowed`, neue Art `gkv_handover`). Kein § 302-Datensatz.
- **Archiv (Fachfrage 37, GoBD)**: Der erste Download erzeugt das Paket, legt es verschlüsselt ab (`storeEncrypted`) und
  verzeichnet es mit SHA-256 in `billing_batch_exports` – in einer Transaktion mit dem Übergabevermerk und unter
  Zeilensperre des Laufs (gleichzeitige Erst-Exporte → genau ein Archiv). Jeder weitere Download (auch der CSV-Link, der
  jetzt `verordnungen.csv` aus dem Archiv liefert) gibt **byte-gleich** diese Datei aus, gekennzeichnet als „Nachdruck“
  (Dateiname, Header `X-Podo-Nachdruck`). Prüfsumme falsch/Datei unlesbar → Abbruch mit Hinweis, keine Neuerzeugung.
  Damit sind auch Behandlungstage, Unterschriften und „Zuzahlung erhalten am“ des übergebenen Stands belegbar (bisher
  nicht eingefroren, siehe Fachfrage 37). Läufe, die vor Paket E schon per CSV übergeben wurden, werden beim ersten
  Paket-Download mit dem dann aktuellen Stand archiviert und als „nach Erstübergabe“ gekennzeichnet
  (`after_first_handover`, Trigger). `billingBatchExport` (Live-Stand ohne Archiv) ist nur noch für Tests (`@internal`,
  von der App nicht aufgerufen) – keine Übergabe ohne Archiv.
- **Nachbesserung (Bookkeeper/AppSec/Code-Review)**: Storno von Auszahlungen (Gegenbuchung), Rückmeldungsdatei als
  verschlüsselter Beleg, Warnung bei Doppelerfassung (inhaltlicher Schlüssel, Bestätigung nötig), „Noch offen“ aus den
  Absetzungen des Laufs (nach Status), Gebühren (`fee_cents`, netto/brutto), Obergrenze 500 Verordnungen/200 MB je Paket,
  gestreamter Nachdruck, technische PDF-Fehler brechen den Erst-Export ab (fachlich fehlende Dokumente werden gezählt
  und angezeigt), Übergabevermerk vor dem Archiv (Trigger), Absetzung nur zu Verordnungen des Laufs (Trigger),
  Bidi-Zeichen aus Freitexten entfernt, `payoutTotals` mit vollen Abrechnungsrechten. Details:
  docs/GKV-ABRECHNUNGSZENTRUM.md Abschnitte 1 und 3.4. Erster CSV-Download archiviert bereits das ganze Paket.
- **Rückmeldung einlesen**: CSV oder JSON (`podohero-rueckmeldung/1`), höchstens 1 MB/5.000 Zeilen, strikt geprüft
  (Zeilennummern, alles oder nichts), Zuordnung über Verordnungs-ID oder Versichertennummer + Ausstellungsdatum nur zu
  Verordnungen des Laufs, Zeilen anderer Läufe übersprungen. Vorschau ändert nichts; „Übernehmen“ nur mit derselben Datei
  (SHA-256) – legt eine Auszahlung (`billing_batch_payouts`) und neue Absetzungen (`gkv_deductions`, Status „offen“,
  `payout_id`) an; gleiche Absetzungen werden nicht doppelt angelegt; dieselbe Datei je Lauf nur einmal (eindeutiger
  Index). **Keine Änderung an Verordnungen.** Auszahlung auch **von Hand** erfassbar (Betrag, Datum, Referenz).
- **Auswertung Kasse vs. privat (Fachfragen 36/38)**: neue Kennzahl/Monatsspalte **„Zahlungseingang
  Abrechnungszentrum“** (Auszahlungen nach Auszahlungsdatum, Ist) **neben** dem Soll laut Läufen – bewusst nicht
  verrechnet. Laufseite: Soll, ausgezahlt, Absetzungen laut Rückmeldungen, Hilfsrechnung „noch offen“.
- **Datenbank (0068)**: beide Tabellen mit `organization_id`, RLS ENABLE + FORCE (`tenant_isolation`, USING + WITH CHECK),
  `podo_fk_same_org`, `podo_user_in_org`, append-only per Trigger (UPDATE/DELETE/TRUNCATE abgelehnt, auch für den
  Eigentümer) und `REVOKE UPDATE, DELETE` für die App-Rolle (scripts/migrate.ts); Auszahlung nur zu übergebenem Lauf;
  Prüfungen lesen unter RLS und lehnen ohne passenden Praxis-Kontext (`app.org_id`) ab. `gkv_deductions.payout_id`
  unveränderlich, nur zu einer Auszahlung desselben Laufs (`podo_gkv_deduction_guard`). Läufe bleiben eingefroren
  (0066/0067 unverändert; nur der Übergabevermerk wird gesetzt). Keine Personen-Spalten → keine Änderung an
  `podo_delete_patient`/`retentionFacts` (Personen mit abgerechneten Verordnungen sind ohnehin nicht löschbar). Praxis-Export
  (`abrechnung/uebergabe/…`, `exportFile`), `scripts/archive-orphans.ts` (KNOWN_TABLES) und Löschlauf der Praxis
  (automatisch über `organization_id`) berücksichtigen die neuen Tabellen.

### Offene Fachfragen Paket E (Abrechnungszentrum/Steuerberatung/Datenschutz)

42. **Annahme des neutralen Formats**: Welche Abrechnungszentren übernehmen CSV/JSON (`podohero-abrechnung/1`) direkt,
    welche brauchen eine Zuordnung in ihr eigenes Importformat? Reicht das Begleitzettel-PDF als Deckblatt für den
    Papierversand der Verordnungen? (Abrechnungszentrum)
43. **Elektronische Leistungsnachweise**: Akzeptieren Zentren/Kassen die PDF-Leistungsnachweise mit elektronischer
    Unterschrift als Ersatz für das Bestätigungsfeld auf der Rückseite der Verordnung (vgl. offener Punkt 22)? (Abrechnungszentrum)
44. **Rückmeldeformat**: Liefern Zentren je Verordnung Auszahlung und Absetzung (wie hier gefordert) oder nur Summen je
    Sammelrechnung? Bei Summen bleibt nur die Auszahlung von Hand. Ist „eine Auszahlung je Datei“ praxisnah? (Abrechnungszentrum)
45. **Fehleingabe einer Auszahlung**: Umgesetzt als **Storno** (Gegenbuchung mit exakt negativen Beträgen,
    Pflichtbegründung, höchstens einmal, Datum = Tag des Stornos) und Neuerfassung. Offen: Reicht das als
    Korrekturbuchung, oder braucht es einen Stornobeleg/Verweis auf ein Schreiben des Zentrums? (Steuerberatung)
46. **Gebühren des Abrechnungszentrums**: Umgesetzt: `fee_cents` (Rückmeldung „Gebühr EUR“ bzw. Handeingabe, optional);
    Auszahlung = netto nach Gebühr, Anzeige brutto = netto + Gebühr. Offen: Ist die Gebühr als Betriebsausgabe (mit
    Rechnung des Zentrums, ggf. USt) zu buchen und nicht als Minderung der Einnahme? (Steuerberatung)
47. **Abgrenzung Kassenanteil (Fortsetzung 38)**: Die Auswertung zeigt Soll (Lauf) und Ist (Zahlungseingang netto, Stornos
    im Monat des Stornos) nebeneinander. Welche Größe ist für die Gewinnermittlung maßgeblich (Zuflussprinzip § 11 EStG bei
    EÜR), und gehört die Gebühr in den Zufluss (brutto) oder nicht (netto)? (Steuerberatung)
48. **Archiv bei Altläufen**: Läufe, die vor Paket E per CSV übergeben wurden, erhalten ein Archiv mit dem späteren Stand
    („nach Erstübergabe“). Reicht das, oder soll die damalige CSV aus anderen Quellen (E-Mail-Ausgang) beigelegt werden?
    (Steuerberatung/Datenschutz)
49. **Aufbewahrungsfrist des Archivs**: Übergabepaket und – neu – die eingelesenen Rückmeldungsdateien enthalten
    Gesundheitsdaten bzw. Abrechnungsdaten und sind zugleich Abrechnungsunterlage/Buchungsbeleg (10 Jahre § 147 AO bzw.
    § 630f BGB). Gilt jeweils die längere Frist, und wie werden sie danach gelöscht (heute nur mit der Praxis)?
    (Datenschutz/Steuerberatung)
50. **Übermittlungsweg**: Das Paket wird heruntergeladen und von der Praxis übergeben (Portal des Zentrums, verschlüsselte
    E-Mail, Datenträger). Braucht es einen eigenen, verschlüsselten Übertragungsweg (z. B. passwortgeschütztes ZIP,
    SFTP)? Auftragsverarbeitungsvertrag mit dem Zentrum? (Datenschutz)
51. **Rückmeldungsdatei als Beleg**: Die eingelesene Datei wird verschlüsselt archiviert (Prüfsumme, Praxis-Export). Ist sie
    der Buchungsbeleg für den Zahlungseingang, oder ist zusätzlich die Sammelabrechnung/Avis des Zentrums (PDF) abzulegen?
    (Steuerberatung)
52. **Duplikatschutz Hand/Import**: Gleiche Auszahlung (Lauf, Datum, Referenz, Nettobetrag) wird nur nach ausdrücklicher
    Bestätigung ein zweites Mal erfasst. Gibt es Fälle (Teilzahlungen mit gleicher Referenz und gleichem Betrag), in denen
    das regelmäßig vorkommt, oder soll stattdessen streng gesperrt werden? (Abrechnungszentrum/Steuerberatung)
53. **Monat des Stornos**: Ein Storno mindert den Zahlungseingang im Monat des Stornos (nicht rückwirkend im Monat der
    stornierten Auszahlung). Ist das für die Auswertung/EÜR so gewünscht, oder soll ein Storno im Monat der ursprünglichen
    Auszahlung wirken (dann ändern sich abgeschlossene Monate)? (Steuerberatung)
