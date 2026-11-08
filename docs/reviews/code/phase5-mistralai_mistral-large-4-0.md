# Code-Review (Sicherheit): mistralai/mistral-large-4-0

**Kritisch**

1. **Datei:** `src/server/waitlist.ts`, `offerFreedSlot()` – `urls.push(url)` / `return { offered, manual, urls }`
   **Problem:** Die Funktion gibt die vollständigen Annahme-Links inkl. Einmal-Token (`${base}/portal/angebot/${r.token}`) im Rückgabewert zurück. Wird `offerFreedSlot` über eine Server Action/Route aufgerufen, deren Ergebnis an den Browser serialisiert wird (oder landet es in Logs), gelangen die geheimen Tokens an Dritte.
   **Auswirkung:** Jeder Token-Inhaber kann über `acceptOffer()` den Termin im Namen des Patienten annehmen (`patientLinks.usedAt`, neuer `appointments`-Eintrag mit `patientId` des Patienten) – unbefugte Handlung im Namen einer anderen Person, DSGVO-Verstoß.
   **Fix:** `urls` aus `OfferSummary` entfernen bzw. nur maskiert zurückgeben; Token ausschließlich im Versandkanal (E-Mail/SMS) belassen.

**Hoch**

2. **Datei:** `src/app/api/kasse/dsfinvk/route.ts` (`auth.can("invoices.read")`) + `src/server/kasse.ts` `buildDsfinvkExport()` (`assertCan(auth, "invoices.read")`)
   **Problem:** Vollständiger DSFinV-K-/GoBD-Export (alle Z-Bons, Bewegungsgründe `cashMovements.reason`, Differenzbegründungen, Bediener-IDs, TSE-Referenzen) nur mit dem „normalen“ Recht `invoices.read`.
   **Auswirkung:** Jeder Mitarbeitende mit Rechnungs-Lesezugriff kann Kassen-/Fiskaldaten exportieren; `reason`/`differenceReason` können personen- bzw. gesundheitsbezogene Angaben enthalten → Verstoß gegen Least Privilege und DSGVO-Zugriffskontrolle (Art. 32).
   **Fix:** Eigenes Recht (z. B. `fiscal.export`, nur Admin/Fibu) in Route und Serverfunktion verlangen.

3. **Datei:** `src/app/api/kasse/z-bon/[id]/route.ts` – `auth.can("invoices.read")` für `zBonPdfForOrg()`
   **Problem/Auswirkung:** Gleiches Muster: Z-Bon-PDF enthält Zahlungen, Bewegungsgründe und Bedienernamen – Export/Download für jeden mit `invoices.read`.
   **Fix:** Höheres Recht (z. B. `fiscal.read`) fordern.

4. **Datei:** `src/server/waitlist.ts`, `findOffer()` – `db.select(...).from(patientLinks).where(eq(patientLinks.tokenHash, ...))`
   **Problem:** Öffentlicher Token-Endpunkt liest `patientLinks` über das globale `db` ohne `withOrg` und ohne `organizationId`-Filter. Migration `0015` zeigt RLS+FORCE nur für `cash_closings`/`cash_movements` – der Mandantenschutz von `patientLinks` ist damit nicht belegt; bei aktivem FORCE-RLS ohne gesetztes `app.org_id` liefern die Abfragen leer (Feature bricht), ohne RLS fehlt die Mandantentrennung am öffentlichen Endpunkt.
   **Auswirkung:** Prinzipbruch Defense-in-Depth; bei fehlendem RLS liest ein öffentlicher, nicht authentifizierter Endpunkt eine Tabelle ohne Mandantenkontext.
   **Fix:** RLS-Policy für `patientLinks` analog 0015 sicherstellen (FORCE) und den Lookup in `withOrg()` nach org-Ermittlung ausführen.

**Mittel**

5. **Datei:** `src/app/portal/angebot/[token]/…` – Token im URL-Pfad
   **Problem:** Token landet in Server-/Proxy-Logs, Browser-Historie und bei externen Requests im `Referer`-Header der Angebotsseite.
   **Auswirkung:** Token-Leak vor Annahme ermöglicht Terminübernahme (siehe 1).
   **Fix:** `Referrer-Policy: no-referrer` auf allen Portal-Seiten, keine externen Ressourcen auf der Angebotsseite laden, Token-URLs in Log-Retention bereinigen (Gültigkeit nach `usedAt`/`revokedAt` ist bereits gegeben).

6. **Datei:** `src/app/api/health/deep/route.ts` – `const secret = process.env.HEALTH_TOKEN || process.env.CRON_SECRET`
   **Problem:** Fallback auf `CRON_SECRET`, das üblicherweise als Bearer an externe Cron-Dienste übergeben wird.
   **Auswirkung:** Leak beim Cron-Anbieter entsperrt den Health-Endpunkt (Antwort enthält nur Metadaten, aber interne Backup-/Cron-Zeitpunkte und Migrationsstände).
   **Fix:** Nur dediziertes `HEALTH_TOKEN` akzeptieren; `CRON_SECRET` nicht wiederverwenden.

7. **Datei:** `src/lib/kasse/dsfinvk.ts`, `buildDsfinvkFiles()` – `TSE_TA_SIG: ""`, `TSE_TA_START/ENDE: ""`; `tse.csv` mit leeren `TSE_PUBLIC_KEY`/Zertifikaten
   **Problem:** Exportierte TSE-Daten sind unvollständig (TODOs im Code), Signatur-Nachweis fehlt.
   **Auswirkung:** Bei einer Außenprüfung (GoBD/DSFinV-K/KassenSichV) ist die Manipulationssicherheit der Einzelaufzeichnungen nicht nachweisbar.
   **Fix:** Signatur, Start/Ende, Vorgangsdaten, Public Key und Zertifikate vom TSE-Anbieter übernehmen, persistieren und exportieren.

8. **Datei:** `src/server/waitlist.ts`, `offerFreedSlot()` – `const base = (deps.baseUrl ?? process.env.PUBLIC_URL ?? "")`
   **Problem:** Kein Protokoll-Check; bei `http://` als PUBLIC_URL werden Annahme-Links mit Token unverschlüsselt per E-Mail/SMS versendet.
   **Auswirkung:** Token kann auf dem Transportweg (Mail-Provider, SMS-Gateway, Logs dazwischen) mitgelesen werden → Terminübernahme (siehe 1).
   **Fix:** `https://` für `base` erzwingen bzw. App-Start bei unsicherem PUBLIC_URL verweigern.

**Niedrig**

9. **Datei:** `src/server/kasse.ts`, `closeDay()` – `pg_advisory_xact_lock(hashtext(...))` (32-bit) vs. `hashtextextended(...)` (64-bit) in `portal-booking.ts`/`waitlist.ts`
   **Problem:** Inkonsistente Lock-Hashes; `hashtext` hat kleine Kollisionsdomäne.
   **Auswirkung:** Theoretisch Lock-Kollision zwischen Mandanten → gegenseitige Blockade (Verfügbarkeit), keine Sicherheitslücke.
   **Fix:** Konsistent `hashtextextended` verwenden.

10. **Datei:** `src/app/portal/angebot/[token]/actions.ts` – `portalFailLimiter.exceeded(key)` wird geprüft, der Zähler aber nur bei `state === "invalid"` via `limited(key)` erhöht
    **Problem:** Fail-Limiter zählt nur einen Fehlertyp; effektiv begrenzt zwar `portalLimiter` pro IP, bei verteilten Angriffen (viele IPs) bleiben Token-Probes möglich.
    **Auswirkung:** Theoretische Enumeration gültiger Angebot-Tokens (Token-Raum/Entropie nicht im Code belegt).
    **Fix:** `limited(key)` bei jedem nicht-ok-Ergebnis aufrufen; zusätzliches globales Limit pro Token-Hash.