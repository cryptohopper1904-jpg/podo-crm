# Schema-Wünsche (aus Integrationen und Excel-Import)

Noch nicht umgesetzt – bitte bei der nächsten Migration prüfen. Bis dahin werden die Werte wie beschrieben behelfsweise abgelegt.

## patients
| Feld | Typ | Grund | Behelf aktuell |
|---|---|---|---|
| `route` | text | Excel „Route“ (Hausbesuchstour) | in `notes` als „Route (Altdaten): …“, `home_visit = true` |
| `maiden_name` | text | Doctolib-Export `maiden_name` | nur im `PatientDraft`, nicht gespeichert |
| `occupation` | text | Doctolib `occupation` | nur im Draft |
| `referrer` | text | Doctolib `referrer` (Zuweiser) | nur im Draft |
| `gp_city` | text | Doctolib `regular_doctor_city` | nur im Draft |
| `crucial_info` | text oder `risk_flags.other` | Doctolib `crucial_info` (wichtige Hinweise) | nur im Draft |
| `no_reminders` | boolean | Doctolib `no_notifications_for_doctor_appointment` | nur im Draft (ggf. über `consents` abbilden) |
| `external_ids` | jsonb `{ doctolib?: string, legacyExcel?: number }` | Abgleich bei erneutem Import/Export | Legacy-ID = `number` |

## vouchers
| Feld | Typ | Grund |
|---|---|---|
| `opening_redeemed_cents` (oder Startbuchung) | integer | Excel „Restbetrag“: bereits eingelöste Beträge aus der Altzeit. Aktuell nur als Text in `note`, daher stimmt der berechnete Restwert (aus `payments`) für Alt-Gutscheine nicht. |

## invoices
| Feld | Typ | Grund |
|---|---|---|
| `collective_invoice_id` | uuid → invoices.id | Zuordnung Einzelleistung → Sammelrechnung (Excel „SR-ID“). Aktuell werden SR-Teile als Positionen in die Sammelrechnung übernommen. |
| `source` | text | z. B. `excel-import` – Altrechnungen von CRM-Rechnungen unterscheiden (aktuell nur in `notes`). |

## number_sequences
- Nach dem Excel-Import muss `next` für Rechnungen/Quittungen hinter die höchste Altnummer gesetzt werden, sonst drohen Nummernkollisionen (Unique-Index `invoices_org_number`). Logik gehört in den Rechnungsnummern-Service; `persistImport` setzt das derzeit NICHT.
