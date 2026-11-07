# Code-Review (Sicherheit): ~google/gemini-pro-latest

Hier sind die konkreten Sicherheitsmängel im geprüften Code, absteigend sortiert nach Schweregrad:

### KRITISCH

**1. Fehlende und optionale Webhook-Authentifizierung (Unauthenticated Webhook Spoofing)**
* **Datei:** `src/app/api/webhooks/[provider]/route.ts`, Zeilen 54–60
* **Problem:** 
  1. Für `lexoffice`, `sms` und `voice_agent` existiert keinerlei Signatur- oder Token-Prüfung.
  2. Für `sumup` und `whatsapp` findet die HMAC-Prüfung nur statt, wenn ein Secret hinterlegt ist (`if (... && secret.webhookSecret)`). Ist keines konfiguriert oder die Verbindung im Status `disconnected`/`null`, wird die Prüfung übersprungen (Fail-Open).
* **Auswirkung:** Angreifer, die eine `organizationId` kennen oder erraten, können beliebige gefälschte Zahlungsbestätigungen (SumUp), eingehende Patientennachrichten (WhatsApp/SMS) oder Voice-Events in das System einschleusen.
* **Fix:** Fail-Closed erzwingen. Wenn `conn?.status !== "connected"` oder das jeweilige Secret fehlt, sofort mit HTTP 401/403 abbrechen. Für `sms`, `lexoffice` und `voice_agent` zwingend HMAC-Signaturen oder (falls vom Provider nicht unterstützt) einen kryptografischen Bearer-Token/Basic-Auth-Abgleich gegen `secret` implementieren.

**2. Server-Side Request Forgery (SSRF) & Credential Exfiltration über `baseUrl`**
* **Datei:** `src/app/(app)/einstellungen/schnittstellen/actions.ts` (Zeilen 49–53) i. V. m. `src/integrations/registry.ts` (Zeilen 64, 73, 81, 88, 96)
* **Problem:** Nutzer mit der Berechtigung `integrations.manage` können beliebige URLs in `config_baseUrl` (oder `smtpHost`/`imapHost`) speichern. Bei `testIntegrationAction` oder im Live-Betrieb sendet der Server Requests inkl. hinterlegter API-Keys/Tokens oder Patientendaten (Transkription/LLM) an diese URL.
* **Auswirkung:** Zugriff auf interne Metadaten-Dienste (z. B. AWS IMDS `169.254.169.254`), interne Netzwerke oder Auslesen bestehender API-Keys (wenn ein bestehender Key nicht gelöscht, aber die `baseUrl` auf einen Angreifer-Server geändert wird).
* **Fix:** `baseUrl` gegen eine strikte Allowlist erlaubter HTTPS-Domains validieren (oder private IP-Ranges/Loopback auf DNS/Socket-Ebene blockieren). Wenn `baseUrl` geändert wird, müssen bestehende `secret`-Felder zwingend invalidiert/gelöscht werden.

---

### HOCH

**3. Cross-Channel Nachrichteninjektion & unverschlüsselter Versand (DSGVO Art. 9 / Art. 32)**
* **Datei:** `src/app/buchen/[slug]/actions.ts` (Zeilen 74–82) i. V. m. `src/app/(app)/posteingang/actions.ts` (Zeilen 79–87)
* **Problem:** 
  1. `bookAction` erzeugt einen Posteingangs-Eintrag mit `channel: "email"`, setzt aber `fromAddress` nicht. `sendReplyAction` bricht dann mit `"Absenderadresse fehlt"` ab (Broken Functionality).
  2. Noch gravierender: Über `sendReplyAction` können Mitarbeiter Freitextantworten (die in einer Podologie-Praxis regelmäßig Gesundheitsdaten/Befunde enthalten) unverschlüsselt per E-Mail, SMS oder WhatsApp an unbestätigte Adressen (`m.fromAddress`) senden, ohne dass eine ausdrückliche Einwilligung für unverschlüsselte elektronische Kommunikation geprüft wird.
* **Auswirkung:** Unbefugte Offenlegung von Gesundheitsdaten (DSGVO-Verstoß), insbesondere wenn bei einer Online-Buchung eine fremde E-Mail/Telefonnummer angegeben wurde.
* **Fix:** In `sendReplyAction` vor dem Versand über unsichere Kanäle (`email`, `whatsapp`, `sms`) in der Tabelle `consents` prüfen, ob für `m.patientId` eine aktive Einwilligung für den jeweiligen Kanal vorliegt, oder den Versand auf rein organisatorische Templates beschränken.

**4. Unzureichende Pseudonymisierung von Patientennamen vor LLM-Versand (DSGVO Art. 5 / Art. 9)**
* **Datei:** `src/app/api/ai/voice-report/route.ts` (Zeilen 52–56) und `src/integrations/llm/redact.ts` (Zeilen 64–67)
* **Problem:** In `voice-report/route.ts` verlässt sich der Server komplett darauf, dass der Client `knownNames` im `FormData` mitschickt. Wird `knownNames` vergessen oder leer gelassen, werden im Diktat genannte Patientennamen im Klartext an das externe LLM gesendet. Zudem wird `patientId` (Zeile 64) nur fürs Audit-Log genutzt, nicht um den Namen aus der DB zu laden.
* **Auswirkung:** Übermittlung von Klarnamen in Verbindung mit medizinischen Befunden an Drittanbieter (LLM).
* **Fix:** Wenn `patientId` übergeben wird, `firstName`, `lastName` und ggf. `maidenName` serverseitig aus der Datenbank laden und zwingend an `knownNames` anfügen.

---

### MITTEL

**5. Fehlerhafte Patienten-Zusammenführung & Datenüberschreibung bei Online-Buchung**
* **Datei:** `src/app/buchen/[slug]/actions.ts`, Zeilen 52–54 und 68–71
* **Problem:** Das Matching bestehender Patienten lädt alle Patienten mit gleichem Nachnamen in den Speicher und prüft `phoneMobile === phone || email === d.email`. Teilen sich Familienmitglieder (z. B. Ehepartner oder Eltern/Kind mit gleichem Nachnamen) eine Telefonnummer oder E-Mail-Adresse, wird der Termin – inklusive der möglicherweise sensiblen `note` – dem falschen Patienten zugeordnet. Zudem führt `tx.insert(consents)` ohne `onConflictDoUpdate` bei bestehenden Patienten zu Duplikaten oder Constraint-Fehlern.
* **Auswirkung:** Vermischung von Patientenakten und Behandlungsnotizen zwischen Familienangehörigen.
* **Fix:** Beim Matching zwingend auch `firstName` (case-insensitiv) abgleichen: `and(eq(patients.lastName, d.lastName), ilike(patients.firstName, d.firstName))`.

**6. Kein Rate-Limiting & Ressourcenerschöpfung bei KI-Audio-Upload**
* **Datei:** `src/app/api/ai/voice-report/route.ts`, Zeilen 30–48
* **Problem:** Der Endpunkt puffert bis zu 25 MB Audio komplett im RAM (`req.formData()` + `audio.arrayBuffer()`) und ruft zwei externe kostenpflichtige APIs (Whisper + LLM) auf, ohne Rate-Limiting pro User/Organisation.
* **Auswirkung:** Ein kompromittierter Account kann durch parallele Requests einen Out-Of-Memory-Absturz (DoS) des Node-Prozesses oder hohe API-Kosten (Denial of Wallet) verursachen.
* **Fix:** Rate-Limit (z. B. max. 10 Requests / 10 Min. pro User/Org) vor dem Einlesen des Request-Bodys (`req.formData()`) prüfen.

---

### NIEDRIG

**7. Unbegrenztes Wachstum der Rate-Limit-Map (Memory Leak)**
* **Datei:** `src/app/buchen/[slug]/actions.ts`, Zeilen 13–20
* **Problem:** Die globale Map `hits` speichert IP-Adressen dauerhaft. Alte Schlüssel werden nie gelöscht, sondern nur bei erneutem Zugriff derselben IP gefiltert.
* **Auswirkung:** Bei verteilten Zugriffen (Botnet/Scanner mit wechselnden IPs) wächst die Map unbegrenzt im Arbeitsspeicher.
* **Fix:** Maximale Größe für `hits` definieren (z. B. `if (hits.size > 10000) hits.clear()`) oder abgelaufene Einträge periodisch bereinigen.