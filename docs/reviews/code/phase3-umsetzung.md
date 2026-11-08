# Phase 3 – Umsetzung der externen Reviews (GPT-5.6, Gemini Pro, Grok 4.7, Mistral Large 4)

| Befund | Schwere | Status |
|---|---|---|
| Vollexport im Support-Modus möglich (synthetische Rolle „owner“) | kritisch | **behoben** – Export und Kündigung schließen Support aus |
| Support (Scope write) konnte Löschung beantragen | hoch | **behoben** |
| Ersteinrichtung ohne SETUP_TOKEN | kritisch | **behoben** – in Produktion Pflicht (fail-closed), install.sh setzt es |
| TOTP-Replay bei parallelen Anfragen | hoch | **behoben** – atomares bedingtes Update |
| Kein IP-Rate-Limit am Login | hoch | **behoben** – 30 Versuche / 15 min je Anschluss |
| Support-write: Aktionen ohne Recht / import.run | mittel | **behoben** – Support schreibt nur über settings/integrations |
| Checkout ohne Zahlungsnachweis aktiviert | hoch | **behoben** – nur bei paid/no_payment_required |
| Veraltetes invoice.payment_failed | mittel | **behoben** – Reihenfolgeprüfung für alle Abo-/Rechnungs-Events |
| settings-Überschreiben durch Webhook | mittel | **behoben** – jsonb-Merge + Zeilensperre |
| billing_events speichert volles Stripe-Payload | mittel | **behoben** – nur IDs/Status |
| Session-Update ohne User-Bindung | mittel | **behoben** |
| Webhook-Antwort verrät Ergebnis | niedrig | **behoben** |
| Konto-Orakel bei Login/Registrierung | niedrig | **behoben** – generische Meldungen |
| Voice: Replay erzeugt doppelte Nachrichten | mittel | **behoben** – Duplikatprüfung je Anruf |
| hashtext-Kollisionen bei Advisory Locks | mittel | **behoben** – hashtextextended (64 Bit), Online- und Telefonbuchung teilen den Lock |
| Dateien bleiben bei Fehler nach Purge-Commit | hoch | **behoben** – Lösch-Skript entfernt verwaiste Ablage-Ordner bei jedem Lauf |
| Support-Freigabe nicht personengebunden | mittel | bewusst offen: gilt für alle Betreiber-Admins mit 2FA (kleines Team); auf der Roadmap |
| Export im Arbeitsspeicher | mittel | bewusst offen (Praxisgrößen klein, 1 Export/10 min); Streaming auf der Roadmap |
| Session-Token-Rotation beim Support-Wechsel | mittel | offen – Freigabe wird bei jeder Anfrage geprüft; Rotation auf der Roadmap |
| Gesperrte Konten behalten Sitzungen | mittel | offen – Sperre betrifft Fehlversuche, nicht Entzug; Entzug löscht Mitgliedschaft |
| Audit-Spam support.view, X-Forwarded-For, __Host-Cookie | niedrig | offen (Betrieb hinter Caddy, dokumentiert) |
