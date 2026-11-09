# Gesamt-Review (Sicherheit, extern): ~google/gemini-pro-latest

Geprüfte Dateien: src/lib/auth/session.ts, src/lib/auth/access.ts, src/lib/auth/cookie.ts, src/lib/auth/permissions.ts, src/lib/auth/support-view.ts, src/lib/auth/client-ip.ts, src/server/authz.ts, src/proxy.ts, src/app/api/webhooks/[provider]/route.ts, src/server/webhooks.ts, src/server/portal-core.ts, src/server/kasse.ts, src/server/practice-export.ts, src/app/api/voice/[provider]/route.ts, src/server/support.ts

Hier ist das Ergebnis des Security-Reviews des vorliegenden Gesamtsystems (sortiert nach Schweregrad).

---

### HOCH

#### 1. Umgehung des Support-View-Audit-Logs (Break-Glass) durch Header-Spoofing
* **Beleg:** `src/lib/auth/support-view.ts:47-49` i. V. m. `src/lib/auth/session.ts:156, 224` und `src/proxy.ts:13-17`
* **Problem:** `isPrefetch()` prüft die vom Client frei setzbaren Header `next-router-prefetch: 1`, `purpose: prefetch` und `sec-purpose: prefetch`. `src/proxy.ts` überschreibt zwar `x-podo-method` und `x-podo-path`, filtert oder validiert die Prefetch-Header aber nicht. Bei gesetztem Header gibt `supportViews.shouldLog()` für alle Lesezugriffe (`!req.mutating`) sofort `false` zurück (`support-view.ts:29`), während Next.js die reguläre Seite, RSC-Payload oder Datei (`/api/...` Downloads von Fotos/PDFs/Exporten) trotzdem vollständig ausliefert.
* **Auswirkung:** Ein Plattform-Admin im Break-Glass-Support-Modus kann sämtliche Patientenakten, Diagnosen (Art. 9 DSGVO) und Dokumente einer Praxis abrufen und herunterladen, ohne dass ein einziger `support.view`-Eintrag im Audit-Log der Praxis entsteht. Dies bricht die Nachvollziehbarkeit nach DSGVO und § 203 StGB.
* **Fix:** In `support-view.ts` `isPrefetch()` komplett entfernen oder ausschließlich echte, leere Next.js-Prefetch-Anfragen (die noch keine Fachdaten in `getAuth()` laden) ignorieren. Sobald `getAuth()` in einer Server Component oder einem Route-Handler ausgeführt wird, werden reale Praxisdaten verarbeitet und der Zugriff **muss** zwingend geloggt werden (Entprellung über `SUPPORT_VIEW_DEDUP_MS` reicht gegen Log-Flutung aus).

#### 2. Replay-Angriffe und fehlende Idempotenz bei Voice- und Messaging-Webhooks
* **Beleg:** `src/app/api/voice/[provider]/route.ts:72-87` sowie `src/app/api/webhooks/[provider]/route.ts:104-112, 122`
* **Problem:**
  1. `/api/voice/[provider]` prüft weder einen Zeitstempel in der Signatur (bzw. nutzt ein statisches `x-vapi-secret`) noch existiert eine Deduplizierung über `claimWebhookEvent()`.
  2. `/api/webhooks/[provider]` berechnet in Zeile 122 `externalId = bodyHash(rawBody)` für `whatsapp`, `sms` und `voice_agent`. Ändert sich auch nur ein Metadatum (z. B. Delivery-Timestamp des Providers) oder sendet ein Angreifer im Fall von statischen URL-Tokens (`?token=`) alte Payloads erneut, fehlt bei Voice jeglicher Replay-Schutz; bei SMS/Telefonagent im Webhook-Handler ist das Token zudem in der URL (`?token=`, Zeile 110) exponiert (Landung in Proxy-/Access-Logs).
* **Auswirkung:** Abgefangene oder wiederholte Tool-Calls des KI-Telefonagenten (`processVoiceEvent`) können Termine mehrfach buchen/stornieren oder Patientenaktionen wiederholt auslösen.
* **Fix:** In `api/voice/[provider]/route.ts` ebenfalls `claimWebhookEvent()` anhand einer eindeutigen Call-/Tool-Call-ID des Providers erzwingen und bei Retell/Vapi Timestamp-Toleranzen (z. B. max. 5 Minuten) prüfen. Webhook-Tokens über Authorization-Header statt Query-Parameter entgegennehmen (oder zumindest zusätzlich akzeptieren).

#### 3. Fehlende Autorisierungsprüfung in `buildPracticeExport` und `zBonPdfForOrg` (Verletzung von Defense-in-Depth)
* **Beleg:** `src/server/practice-export.ts:49` und `src/server/kasse.ts:539`
* **Problem:** Während alle anderen Server-Funktionen (`kasse.ts:207, 242, 273, 535, 575`, `portal-core.ts:33`) konsequent `assertCan(auth, ...)` am Funktionseingang aufrufen, akzeptieren `buildPracticeExport(opts: ExportOptions)` und `zBonPdfForOrg(org: string, id: string)` lediglich eine rohe `organizationId: string` ohne `AuthContext` und ohne Berechtigungsprüfung. Zudem schreibt `buildPracticeExport` selbst keinen Audit-Log-Eintrag über den Vollabzug aller Gesundheitsdaten.
* **Auswirkung:** Wird eine dieser Funktionen in einer Route oder Server Action ohne vorheriges `requireAuth("settings.manage")` bzw. `requireAuth("cash.read")` aufgerufen (oder von einem Support-Admin im Read-Scope getriggert, da `effectiveCan` in `access.ts:33` alle `.read`-Rechte für Support freigibt!), werden sämtliche Gesundheitsdaten + Medien entschlüsselt exportiert.
* **Fix:** Signatur von `buildPracticeExport` auf `(auth: AuthContext, opts: ...)` ändern, darin explizit `if (auth.support || auth.role !== "owner") throw new ForbiddenError(...)` erzwingen und den Export zwingend in `auditLog` protokollieren. In `zBonPdfForOrg` `auth: AuthContext` verlangen und `assertCan(auth, "cash.read")` aufrufen.

---

### MITTEL

#### 4. Support-Grant-Eskalation bei mehreren parallelen Freigaben (`pickActiveGrant`)
* **Beleg:** `src/lib/auth/access.ts:68-73`
* **Problem:** `pickActiveGrant` sortiert aktive Freigaben ausschließlich nach Ablaufdatum (`b.expiresAt.getTime() - a.expiresAt.getTime()`) und ignoriert den `scope` sowie `createdAt`. Hat eine Praxis z. B. versehentlich einen 48h-Grant mit Scope `write` angelegt und legt direkt danach zur Korrektur einen 2h-Grant mit Scope `read` an (ohne den ersten sofort zu widerrufen), wählt `pickActiveGrant` weiterhin den länger gültigen `write`-Grant. Umgekehrt überschreibt ein alter `read`-Grant mit längerer Restlaufzeit einen neu erteilten, kurzen `write`-Grant.
* **Auswirkung:** Unerwartete Rechtevergabe (`settings.manage`, `integrations.manage`) im Support-Modus entgegen der jüngsten Entscheidung des Praxisinhabers.
* **Fix:** Bei `createSupportGrant()` (`src/server/support.ts:68`) vorab alle bestehenden aktiven Grants für diese Praxis (oder zumindest für denselben `granteeUserId`) automatisch widerrufen (`revokedAt = now`), analog zu `insertPortalLinkLocked` in `portal-core.ts:63`.

#### 5. Unvollständige Transaktions-Isolation beim Praxis-Export (Inkonsistenter Snapshot & fehlende `withOrg`-Nutzung bei `sessions`/`users`)
* **Beleg:** `src/server/practice-export.ts:93-111, 208-218`
* **Problem:** `pages()` öffnet für jede einzelne Tabellenseite eine neue, unabhängige Kurz-Transaktion (`withOrg`). Während eines großen Exports (viele Medien) können parallel geschriebene Datensätze zwischen Tabellen (z. B. `invoices` vs. `invoice_lines` oder `payments`) inkonsistent exportiert werden. Zudem nutzt das Keyset-Paging `gt(cols.id, after)` mit `orderBy(asc(cols.id))` – bei UUIDv4-Spalten können während des Exports neu eingefügte Zeilen mit kleinerer UUID übersprungen werden.
* **Auswirkung:** Der gesetzlich vorgeschriebene Archiv-Export (§ 630f BGB, § 147 AO) kann referentielle Inkonsistenzen aufweisen.
* **Fix:** Für den Tabellen-Export (Schritt 2, ohne Medien-Streaming) eine einzige DB-Transaktion mit `ISOLATION LEVEL REPEATABLE READ` (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`) verwenden.

#### 6. Kein automatisches Zurücksetzen von ` organizationId` für Nicht-Platform-Admins bei deaktivierter Mitgliedschaft
* **Beleg:** `src/lib/auth/session.ts:206-218`
* **Problem:** Hat ein regulärer Nutzer (`!row.user.isPlatformAdmin`) mehrere Praxen und wird seine Mitgliedschaft in der aktuell in `sessions.organizationId` aktiven Praxis deaktiviert (`memberships.active = false`), gibt `getAuth()` in Zeile 207 sofort `null` zurück, ohne (wie für Platform-Admins in Zeile 209-217) auf eine andere aktive Mitgliedschaft des Nutzers umzuschalten.
* **Auswirkung:** Der Nutzer landet in einer Redirect-Schleife auf `/login` (da das Session-Cookie in `proxy.ts:26` noch existiert, `requireAuth()` aber auf `/login` umleitet), bis er manuell Cookies löscht.
* **Fix:** Den Fallback auf `own` (Zeilen 209–217) für alle Nutzer ausführen, nicht nur für `row.user.isPlatformAdmin` (das `support.ended`-Audit-Log dabei weiterhin nur schreiben, wenn `row.user.isPlatformAdmin` wahr ist).

---

### NIEDRIG

#### 7. Information Disclosure von Plattform-Admin-Daten an Nicht-Inhaber
* **Beleg:** `src/server/support.ts:43-50` und `src/server/support.ts:111-126`
* **Problem:** `listSupportAdmins()` besitzt überhaupt keine Autorisierungsprüfung (`auth` wird nicht einmal übergeben) und gibt Namen sowie E-Mail-Adressen aller Plattform-Admins zurück. `listSupportGrants()` erlaubt den Zugriff über `auth.can("settings.manage")`, was im Support-Modus mit Scope `write` nur durch `!auth.support` abgefangen wird, aber von `ownerOnly` in Zeile 36 abweicht.
* **Auswirkung:** Jeder authentifizierte Codepfad, der `listSupportAdmins()` aufruft, kann die Liste aller Betreiber-Admins auslesen.
* **Fix:** `listSupportAdmins(auth: AuthContext)` mit `ownerOnly(auth)` absichern. In `listSupportGrants` ebenfalls einheitlich `ownerOnly(auth)` verwenden.

#### 8. Fehlende Längenbegrenzung/Sanitisierung von `hub.challenge` (Reflected Content)
* **Beleg:** `src/app/api/webhooks/[provider]/route.ts:80`
* **Problem:** `sp.get("hub.challenge")` wird bei gültigem `verifyToken` ungeprüft und unbegrenzt im Body zurückgegeben.虽然 `Content-Type: text/plain` gesetzt ist, fehlt `X-Content-Type-Options: nosniff` auf der Response.
* **Auswirkung:** Bei kompromittiertem oder erratbarem `verifyToken` einer Praxis ist Content-Spoofing / Reflektion beliebiger Payloads unter der App-Origin möglich.
* **Fix:** `hub.challenge` auf `/^[a-zA-Z0-9_-]{1,128}$/` validieren und `X-Content-Type-Options: nosniff` setzen.