# GKV-Grundlagen Podologie (Kassenpraxen)

Stand: 17.11.2026 · Regelwerk `podo-2026-11-anlage3-2025-06` (`RULES_VERSION` in `src/lib/rules/prescription.ts`)

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
| Snapshot-Zeilen | je (Behandlungstag, ZL-Positionsnummer) genau eine Zeile: zwei Einträge am selben Tag werden zusammengefasst (Einheiten/Zuzahlung addiert, Hinweis „zwei Behandlungseinträge“), doppelte Positionen auf der VO vorher (Hinweis „mehrfach auf der Verordnung“); gedeckelte Pauschale steht als Hinweis | Export #110 (Position je Tag eindeutig); Review PR #111 Runde 3 | `priceSnapshot`, `mergePositions` |
| 78610 je Tag | bis zu zweimal je Tag; im Snapshot so verteilt, dass die verordneten Einheiten auf die Behandlungstage passen; vorzeitig beendete VO (Abbruchvermerk) nur einmal je Tag; jede Annahme „2 × am Tag“, nicht verteilbare Einheiten und zwei Einträge am selben Tag stehen als Hinweis im Snapshot | Anlage 2 § 2 Abs. 2 Buchst. c | `GkvPosition.maxPerDay`, `priceSnapshot` |
| Abgerechnet | unveränderbar (DB-Trigger `prescriptions_billed_lock`), nur „Zuzahlung erhalten“ (Datum, Betrag, Zahlungsart) darf nachgetragen werden; Neuberechnung des Snapshots (abrechnungsreif → abgeschlossen → abrechnungsreif) protokolliert den alten Snapshot | GoBD-Nachvollziehbarkeit; Review PR #111 S1 | Migration 0062 |
| Abrechnungslauf | nur Verordnungen mit vollständigem Preis-Snapshot | Review PR #111 Runde 2 | `createBillingBatch` |
| „Zuzahlung erhalten“ | nur Vermerk (Barzahlung zusätzlich in der Kasse erfassen); Betrag streng geprüft (Punkt bzw. Leerzeichen nur als Tausendertrenner im Muster 1.234,56 / 1 234,56, sonst Punkt = Dezimaltrenner; höchstens 20 Zeichen); höchstens die Heilmittelkosten der VO (Snapshot bzw. Schätzung), ohne bekannte Kosten 10.000 €; über bzw. unter der berechneten Zuzahlung → Hinweis (Restbetrag offen) | Review PR #111 Runde 2 | `parseEuroInputCents`, `copaymentOverpaid` |
| Löschung der Person | abgerechnete Verordnung (`billed_at`) oder erhaltene Zuzahlung (`copayment_paid_at`) = aufbewahrungspflichtig, keine vollständige Löschung | § 147 AO; AppSec PR #111 N1 | `retentionFacts`, `podo_delete_patient` (0062) |
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
  `created_at`. Wie viele dadurch nach dem Deploy nicht mehr buchbar wären, zählt diese **reine Lese-Abfrage** (als
  Eigentümer-/Admin-Rolle ausführen, sonst filtert RLS; nicht automatisch ausgeführt):

```sql
-- Nur lesen. Zählt je Praxis die laufenden Altbestand-VOs ohne Behandlungseintrag, deren 12-Wochen-Frist ab Anlage
-- (bzw. ab einer späteren Wiederaufnahme) abgelaufen ist (evaluatePrescription: heute > Bezugstag + 84 Tage).
SELECT p.organization_id, count(*) AS gesperrt
  FROM prescriptions p
 WHERE p.status = 'active'
   AND coalesce(p.rules_version, '') NOT LIKE 'import-%'
   AND NOT (coalesce(p.rules_version, '') ~ '^podo-\d{4}-\d{2}' AND substring(p.rules_version FROM 6 FOR 7) >= '2026-11')
   AND NOT EXISTS (SELECT 1 FROM treatment_records t WHERE t.prescription_id = p.id)
   AND greatest((p.created_at AT TIME ZONE 'Europe/Berlin')::date, coalesce(p.reopened_at, '-infinity'::date))
       < (now() AT TIME ZONE 'Europe/Berlin')::date - 84
 GROUP BY p.organization_id
 ORDER BY gesperrt DESC;
```

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
10. **UI-Begründungsfeld** (Lokalisation des Zehs, Anlage 3 Buchst. o2) und das Bestätigungsfeld (Unterschrift je
    Behandlung, Buchst. o) sind noch nicht abgebildet.
11. Kalender-Badge „VO“ am Termin: noch nicht umgesetzt (optional).
12. **Pauschale bei 18. Geburtstag im Behandlungszeitraum**: Ist die 10-€-Verordnungsblattgebühr fällig, wenn die Person
    erst nach dem ersten Termin 18 wird? Aktuell ist der erste Behandlungstag maßgeblich (Vertrag § 8 Abs. 2 Satz 3).
13. **Wiederaufnahme aus „Frist überschritten“**: PodoHero erlaubt sie mit Begründung (z. B. Beginn rechtzeitig, aber nicht
    erfasst) und zählt die 12-Wochen-Frist ab der Wiederaufnahme. Ob Kassen das so akzeptieren, ist nicht belegt – die
    Verantwortung liegt bei der Praxis; bitte mit dem Abrechnungszentrum klären.
14. **Übernahmen mit Status „in Behandlung“** (Import-Altbestand): Beginnfrist gilt als eingehalten; ohne erfassten
    Behandlungstag zählt die 12-Wochen-Unterbrechung ab dem **Importdatum** (die Termine im Altsystem sind nicht bekannt).
    Ob dieser Fristbeginn fachlich trägt, bitte mit dem Abrechnungszentrum klären.
15. **Storno/Korrektur eines Abrechnungslaufs**: abgerechnete Verordnungen sind gesperrt; ein Weg für Rückläufer/Korrekturen
    der Kasse fehlt noch.
16. **Pflegeheim-Praxen**: Bei Besuchstagen im festen Rhythmus (z. B. alle 3 Wochen) kann die verordnete Frequenz
    (DF/NF/QF: alle 4–6 Wochen) unterschritten werden – dann ist je Behandlung eine Begründung (Absprache mit der Ärztin/dem
    Arzt) Pflicht. Ob eine einmalige Absprache für die ganze Verordnung genügt, ist nicht belegt.
17. **78610-Verteilung**: Wie viele 78610 an welchem Tag abgegeben wurden, erfasst PodoHero nicht; der Snapshot verteilt
    (höchstens 2 je Tag, Anlage 2 § 2 Abs. 2 Buchst. c).
18. **Zwei Einheiten am selben Tag**: Zwei Behandlungseinträge am selben Tag für dieselbe Position werden im Snapshot
    angesetzt und nur als Hinweis markiert – ist das abrechenbar?
19. **78610 zweimal täglich ohne Einzelnachweis**: Der Snapshot nimmt „2 × am Tag“ an, wenn die verordneten Einheiten
    sonst nicht auf die Behandlungstage passen. Akzeptieren Kassen das ohne Einzelnachweis in der Doku?
20. **Azubis mit `medical.write`** dürfen „Wiederaufnahme“ und „Zuzahlung erhalten“ setzen – Produktentscheidung offen
    (ggf. eigene Berechtigung).
21. **CSV-Werte „minderjährig“/„gemischt (…)“** in der Spalte „Zuzahlungsbefreit“ vor der ersten Übergabe mit dem
    Abrechnungszentrum abstimmen.
