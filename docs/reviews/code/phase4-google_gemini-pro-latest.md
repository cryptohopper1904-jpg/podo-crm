# Code-Review (Sicherheit): ~google/gemini-pro-latest

### Kritisch

**1. SSRF bei direkter IP-Angabe im KIM-Connector**
* **Datei & Stelle:** `src/integrations/kim/net.ts`, Funktion `resolvePublic` (Zeile 29)
* **Problem:** `if (isIP(h)) return h;` gibt IP-Adressen ungeprüft zurück, bevor `isPrivateIp` aufgerufen wird.
* **Auswirkung:** Wenn ein Praxis-Admin als KIM-Host eine private IP (z. B. `127.0.0.1`, `169.254.169.254` oder interne Cluster-IPs) einträgt, wird der SSRF-Schutz komplett umgangen.
* **Fix:**
  ```ts
  if (isIP(h)) {
    if (isPrivateIp(h)) throw new UnsafeTargetError("Host zeigt auf eine private oder lokale Adresse.");
    return h;
  }
  ```

### Hoch

**2. Leak des verschlüsselten OCR-API-Keys im Praxis-Export**
* **Datei & Stelle:** `src/server/practice-export.ts`, Funktion `produce` (Zeile 178) i. V. m. `src/integrations/ocr/settings.ts` (Zeile 32)
* **Problem:** Die Zeilendaten von `organizations` werden ungefiltert (`await add(JSON.stringify(orgRow ? [orgRow] : [], ...), { name: "tables/organizations.json" })`) exportiert, ohne `stripRow` anzuwenden. Da die OCR-Konfiguration laut `settings.ts` in `organizations.settings.ocr.apiKeyEnc` liegt, landet das Chiffrat im Export.
* **Auswirkung:** Entgegen der Zusicherung in der `README.txt` („Nicht enthalten: … Zugangsdaten zu Schnittstellen“) wird der verschlüsselte API-Key exportiert. Zudem kann selbst ein berechtigter Support-Admin im Lesemodus (`support.read`) den Export abrufen und erhält Zugriff auf das Chiffrat.
* **Fix:** Vor dem Schreiben von `organizations.json` das Feld `settings.ocr.apiKeyEnc` (sowie ggf. weitere Geheimnisse in `organizations`) explizit über `stripRow` oder eine Bereinigungsfunktion entfernen.

**3. DNS-Rebinding (TOCTOU) beim SMTP-Versand der Praxis**
* **Datei & Stelle:** `src/server/mail.ts`, Funktion `mailPortFor` (Zeile 73–79) und `src/integrations/mail/mail.ts`, `SmtpMailAdapter` (Zeile 156)
* **Problem:** `assertPublicHost(settings.target.host)` prüft zwar die DNS-Auflösung vorab, übergibt danach aber den Hostnamen (nicht die geprüfte IP) an `nodemailer.createTransport({ host: settings.target.host, ... })`. Nodemailer löst den Hostnamen beim Verbindungsaufbau erneut auf.
* **Auswirkung:** Durch DNS-Rebinding (kurze TTL) kann zwischen Prüfung und Verbindungsaufbau auf eine interne IP (`127.0.0.1` etc.) umgeschaltet werden (SSRF).
* **Fix:** Analog zu `src/integrations/kim/net.ts` die aufgelöste öffentliche IP als `host` an Nodemailer übergeben und den ursprünglichen Hostnamen in `tls: { servername: settings.target.host, minVersion: "TLSv1.2" }` setzen.

**4. Replay-Angriffe auf Retell-Webhook durch Legacy-Signaturformat**
* **Datei & Stelle:** `src/integrations/voice/retell.ts`, Funktion `verifyRetellSignature` (Zeile 46–49)
* **Problem:** Neben dem aktuellen Format (`v=<ts>,d=<hmac>`) akzeptiert der Code weiterhin reine 64-stellige Hex-Signaturen ohne Zeitstempel (`if (/^[0-9a-fA-F]{64}$/.test(sig))`).
* **Auswirkung:** Ein einmal abgefangener Webhook-Request (oder eine aus der `v=...,d=...` Signatur vorberechnete Legacy-Signatur, falls der Key kompromittiert/erraten wird, bzw. ein echter alter Request) kann unbegrenzt oft erneut abgespielt werden (Replay), um z. B. KI-Werkzeuge (Terminbuchung, Patientenabfragen) erneut auszulösen.
* **Fix:** Den Fallback für reine Hex-Signaturen ohne Zeitstempel entfernen und ausschließlich das zeitstempelgebundene Format `v=<ts>,d=<digest>` akzeptieren.

### Mittel

**5. SQL-Wildcard-Injection bei der Kandidatensuche in `everordnung.ts`**
* **Datei & Stelle:** `src/server/everordnung.ts`, Funktion `findCandidates` (Zeile 40)
* **Problem:** `ilike(patients.lastName, s.patient.lastName)` nutzt den aus der eVerordnung geparsten Nachnamen direkt als LIKE-Pattern, ohne `%` und `_` zu escapen.
* **Auswirkung:** Enthält eine manipulierte eVerordnung `lastName: "%"` und ein bekanntes Geburtsdatum, gibt die Vorschau bis zu 5 beliebige Patienten der Praxis mit diesem Geburtsdatum inkl. KVNR-Abgleichshinweis zurück.
* **Fix:** Statt `ilike` einen exakten, case-insensitiven Vergleich nutzen (wie bereits in `src/server/kim.ts` Zeile 132 gelöst):
  ```ts
  eq(sql`lower(${patients.lastName})`, s.patient.lastName.toLowerCase())
  ```

**6. SMTP Header-Injection in `buildMail` bei ungeprüftem `from`/`to`**
* **Datei & Stelle:** `src/integrations/kim/smtp.ts`, Funktion `buildMail` (Zeile 161–162)
* **Problem:** `buildMail` setzt `From: ${input.from}` und `To: ${input.to}` direkt in den Header-String ein, ohne CRLF-Bereinigung oder `isMailAddress`-Prüfung (diese findet erst später in `SimpleSmtpTransport.send` für den Envelope statt, nicht aber zwingend beim Aufruf von `buildMail`).
* **Auswirkung:** Falls `input.from` oder `input.to` aus einer nicht strikt validierten Quelle stammen und `\r\n` enthalten, können beliebige MIME-Header oder ein abweichender Mail-Body injiziert werden, die das KIM-Clientmodul dann signiert.
* **Fix:** In `buildMail` zu Beginn prüfen:
  ```ts
  if (!isMailAddress(input.from) || !isMailAddress(input.to)) {
    throw new SmtpError("Ungültige Adresse in Kopfzeile");
  }
  ```

**7. Ungeprüfte Berechtigung bei `listSupportGrants`**
* **Datei & Stelle:** `src/server/support.ts`, Funktion `listSupportGrants` (Zeile 89)
* **Problem:** Während `createSupportGrant` und `revokeSupportGrant` `ownerOnly(auth)` aufrufen, prüft `listSupportGrants(auth)` weder die Rolle noch `auth.can(...)`.
* **Auswirkung:** Wird `listSupportGrants` von einer Seite oder Server Action ohne vorheriges `ownerOnly` aufgerufen, kann jedes Praxismitglied (und der Support-Admin selbst) alle Support-Freigaben inkl. E-Mail-Adressen der Plattform-Admins und Begründungen einsehen.
* **Fix:** Am Anfang von `listSupportGrants` zumindest `assertCan(auth, "settings.manage")` (oder `ownerOnly(auth)`) ergänzen.

### Niedrig

**8. Sequenzieller Cron-Lauf (`runKimSyncAll`) anfällig für DoS / Timeout**
* **Datei & Stelle:** `src/server/kim.ts`, Funktion `runKimSyncAll` (Zeile 106–124)
* **Problem:** Alle Praxen werden in einer `for`-Schleife nacheinander (`await syncKimInbox(o.id)`) abgearbeitet. Je Praxis beträgt das POP3-Timeout 20 Sekunden pro Befehl.
* **Auswirkung:** Hängen die KIM-Clientmodule weniger Praxen (Timeout), blockiert der gesamte Cron-Job und nachfolgende Praxen erhalten keine KIM-Nachrichten mehr (Serverless/Route-Timeout).
* **Fix:** Verarbeitung mit begrenzter Parallelität (z. B. Batches von 5–10 Praxen via `Promise.allSettled`) und einem harten Gesamt-Timeout pro Praxis kapseln.