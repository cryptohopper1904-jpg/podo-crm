# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Kritisch

### 1. SSRF-Schutz durch direkte IP-Adressen umgehbar
- **Datei/Stelle:** `src/integrations/kim/net.ts`, `resolvePublic()`:
  ```ts
  if (isIP(h)) return h;
  ```
- **Auswirkung:** Private oder lokale IP-Literale wie `127.0.0.1`, `::1` oder RFC1918-Adressen werden ohne `isPrivateIp()` akzeptiert. Eine entsprechend konfigurierte KIM-Verbindung kann interne TLS-Dienste erreichen und damit Netzwerkgrenzen umgehen.
- **Fix:**
  ```ts
  if (isIP(h)) {
    if (isPrivateIp(h)) throw new UnsafeTargetError("Private oder lokale Adresse nicht erlaubt.");
    return h;
  }
  ```

## Hoch

### 2. DNS-Rebinding/TOCTOU beim Praxis-SMTP
- **Datei/Stelle:** `src/server/mail.ts`, `mailPortFor()` prüft mit `assertPublicHost()`; anschließend verbindet Nodemailer in `src/integrations/mail/mail.ts` erneut über den Hostnamen.
- **Auswirkung:** Zwischen Sicherheitsprüfung und Nodemailer-DNS-Auflösung kann sich die Adresse ändern. Anders als der KIM-Connector wird nicht mit der bereits geprüften IP verbunden. Dadurch ist SSRF gegen interne Ziele möglich.
- **Fix:** Alle DNS-Adressen prüfen und Nodemailer über einen benutzerdefinierten Socket bzw. gepinnten Lookup ausschließlich mit einer geprüften IP verbinden; TLS-SNI und Zertifikatsprüfung weiterhin gegen den konfigurierten Hostnamen durchführen.

### 3. Plattform-SMTP kann Gesundheitsdaten ohne erzwungenes TLS übertragen
- **Datei/Stelle:** `src/integrations/mail/mail.ts`, Konstruktor `SmtpMailAdapter`:
  ```ts
  : factory(settings.url);
  ```
- **Auswirkung:** Für `SMTP_URL` werden weder `requireTLS` noch eine Mindest-TLS-Version gesetzt. Bei einer `smtp://`-URL kann Nodemailer ohne STARTTLS fortfahren, wenn der Server kein STARTTLS anbietet. Rechnungen, Erinnerungen oder Anhänge können dann unverschlüsselt übertragen werden.
- **Fix:** `SMTP_URL` parsen und auch für Plattform-SMTP `requireTLS: true` sowie `tls: { minVersion: "TLSv1.2" }` setzen; alternativ ausschließlich `smtps://` zulassen.

### 4. Alte Retell-Signaturen sind unbegrenzt wiederverwendbar
- **Datei/Stelle:** `src/integrations/voice/retell.ts`, `verifyRetellSignature()`:
  ```ts
  if (/^[0-9a-fA-F]{64}$/.test(sig)) {
    // HMAC nur über rawBody
  }
  ```
- **Auswirkung:** Das akzeptierte Legacy-Format enthält weder Zeitstempel noch Nonce. Ein mitgeschnittener gültiger Tool-Aufruf oder Webhook kann beliebig oft erneut gesendet werden und erneut Aktionen bzw. Verarbeitung auslösen.
- **Fix:** Legacy-Signaturen entfernen. Falls zwingend erforderlich, den Digest bzw. eine Event-/Call-ID serverseitig mit Ablaufzeit speichern und Wiederholungen atomar ablehnen.

## Mittel

### 5. Patientenanlage und Verordnungsimport sind nicht atomar
- **Datei/Stelle:** `src/server/everordnung.ts`, `importEverordnung()`: Patient wird in `withOrg()` angelegt; `prescriptionInput.safeParse()` und `savePrescription()` erfolgen danach separat.
- **Auswirkung:** Scheitert die Validierung, das Speichern oder der Unique-Check bei einem parallelen Import, bleibt ein neu angelegter Patient ohne Verordnung bestehen. Dadurch entstehen unnötig gespeicherte Gesundheits-/Identitätsdaten und inkonsistente Datensätze.
- **Fix:** Patientennummernvergabe, Patientenanlage, Duplicate-Prüfung und Verordnungsanlage in eine gemeinsame DB-Transaktion verschieben. `savePrescription()` dafür eine bestehende Transaktion übergeben; Audit erst nach erfolgreichem Commit schreiben.

### 6. Praxisexport enthält verschlüsselte OCR-Zugangsdaten
- **Datei/Stelle:** `src/server/practice-export.ts`, vollständiger Export von `orgRow`:
  ```ts
  JSON.stringify(orgRow ? [orgRow] : [])
  ```
  `src/integrations/ocr/settings.ts` speichert `apiKeyEnc` in `organizations.settings.ocr`.
- **Auswirkung:** `tables/organizations.json` enthält damit das verschlüsselte API-Key-Material, obwohl der Export laut README keine Schnittstellen-Zugangsdaten enthalten soll. Das vergrößert die Angriffsfläche bei Verlust des Exports oder späterer Kompromittierung des Anwendungsschlüssels.
- **Fix:** Vor dem Export `settings.ocr.apiKeyEnc` und sämtliche weiteren Secret-/Ciphertext-Felder rekursiv entfernen; nur nicht geheime Konfiguration exportieren.

### 7. POP3-Verbindungen bleiben bei Fehlern und Timeouts offen
- **Datei/Stelle:** `src/integrations/kim/pop3.ts`, `Pop3Client.connect()` und `LineReader.wait()`.
- **Auswirkung:** Fehler bei Begrüßung, `USER`, `PASS` oder ein Timeout zerstören den Stream nicht. Wiederholte fehlerhafte Abrufe können offene Sockets und Ressourcen ansammeln.
- **Fix:** `connect()` vollständig mit `try/catch` umschließen und bei jedem Fehler `close()` aufrufen. Bei Reader-Timeout zusätzlich `stream.destroy()` auslösen und den abgelaufenen Waiter entfernen.