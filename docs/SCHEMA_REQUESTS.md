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
