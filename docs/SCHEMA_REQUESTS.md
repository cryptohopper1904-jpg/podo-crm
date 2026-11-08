# Schema-Wünsche (aus Integrationen und Excel-Import)

## Erledigt (Migration 0002)
patients.route / extra / external_ids, vouchers.opening_redeemed_cents, invoices.collective_invoice_id / source.
Hinweis: Der Excel-Import übernimmt SR-Teilzeilen weiterhin als Positionen der Sammelrechnung (kein doppelter Umsatz),
`collective_invoice_id` bleibt beim Import daher leer. Nummernkreise werden per `ensureSequenceAtLeast` nachgezogen.

## Offen
| Tabelle | Wunsch | Grund |
|---|---|---|
| reviews | Unique-Index (organization_id, provider, external_id) | Abruf aus Google ist sonst nur per Vorab-Select idempotent |
| messages | Unique-Index (organization_id, channel, external_id) | Idempotenz bei Webhook-Wiederholungen (derzeit Vorab-Select) |
| users | `calendar_token_version` integer | iCal-Feed-Link widerrufen, ohne den App-Schlüssel zu rotieren |
| integration_connections | — | Webhook-URL enthält `?org=<uuid>`; alternativ eigenes, zufälliges `webhook_token` je Verbindung |

## Offen (Hygiene & Team-Planung, Phase 2)
| Tabelle | Wunsch | Grund |
|---|---|---|
| tasks | Unique-Index (organization_id, kind, title, due_at) oder Spalte `ref` (z. B. `device:<id>:maintenance`) | `syncHygieneTasks` dedupliziert per Titel (+ Advisory-Lock); ein Schlüssel wäre robuster bei Umbenennung eines Geräts |
| media | `patient_id` nullable + Zweck `device_document` (oder eigene Tabelle) | Prüfprotokolle/Wartungsberichte im Gerätebuch hochladen; derzeit nur Freitext-Notiz |
| treatment_records | Index auf `(organization_id, upper(regexp_replace(sterile_batch_code, '\s', '', 'g')))` | Rückverfolgung Charge → Patient:innen (`/hygiene/charge/[code]`) ohne Seq-Scan |
| sterile_batches | `created_by` uuid | Wer hat die Charge angelegt (Freigebende:r steht in `released_by`) |

## Offen (Verordnungen, Anamnese, Pflegeheim – Phase 2)
| Tabelle | Wunsch | Grund |
|---|---|---|
| anamneses | Spalte `source` text (practice/online) + `rules_version` | derzeit in `data.source`/`data.schemaVersion` (JSON) – für Filter/Auswertung als Spalte besser |
| prescriptions | `positions[].priceCents` (Typ in schema.ts) bzw. Spalte `remedy_cost_cents` | Zuzahlung wird beim Anlegen aus `services.gkv_position` berechnet; der Preis-Snapshot fehlt für spätere Nachvollziehbarkeit |
| billing_batches | `remedy_total_cents` + `copayment_total_cents` statt `total_cents` | `total_cents` enthält derzeit die Summe der Zuzahlungen (Heilmittelkosten sind nicht gespeichert) |
| patient_links | Index `(organization_id, patient_id, purpose)` | Liste/Widerruf der Links je Patient ohne Seq-Scan |
| messages | Kanal `web` (channel-Enum) | Eingang „Anamnesebogen eingegangen“ nutzt derzeit `none` |
| treatment_records | Index `(organization_id, prescription_id)` | Einheiten-Zählung je Verordnung |
