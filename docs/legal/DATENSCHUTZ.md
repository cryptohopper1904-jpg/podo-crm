# Datenschutzerklärung

> **Entwurf – vor Verwendung anwaltlich prüfen lassen.** Diese Vorlage ist keine Rechtsberatung.
>
> Version 0.4 · Stand 13.11.2026

Diese Datenschutzerklärung gilt für die **Website** von PodoHero und für die **Konten der Praxen**, die PodoHero nutzen. Für die Daten der Patientinnen und Patienten, die eine Praxis in PodoHero verarbeitet, ist die jeweilige **Praxis Verantwortliche**; wir verarbeiten diese Daten nur in ihrem Auftrag (siehe [Auftragsverarbeitungsvertrag](/avv)). Patientinnen und Patienten wenden sich mit Fragen bitte an ihre Praxis.

## 1. Verantwortlicher

Pitt Petruschke
Veltener Straße 33
16540 Hohen Neuendorf
Deutschland
E-Mail: [cryptohopper1904@gmail.com](mailto:cryptohopper1904@gmail.com)

<!-- TODO (Betreiber): Telefonnummer ergänzen, sobald vorhanden – keine Nummer erfinden. -->

Eine Pflicht zur Benennung einer/eines Datenschutzbeauftragten besteht derzeit nicht. Datenschutzanfragen richten Sie bitte an die oben genannte Adresse.

## 2. Aufruf der Website

Beim Aufruf der Website verarbeitet unser Server technisch notwendige Daten: IP-Adresse, Datum und Uhrzeit, aufgerufene Seite, übertragene Datenmenge, Browser-Kennung (User-Agent).

- **Zweck:** Auslieferung der Website, Sicherheit (z. B. Abwehr von Angriffen, Begrenzung von Anmeldeversuchen)
- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einem sicheren Betrieb)
- **Speicherdauer:** Sicherheitsprotokolle der Anwendung siehe Abschnitt 4

<!-- TODO (Betreiber): Speicherdauer der Server-Protokolle festlegen und hier angeben. Stand deploy/: Caddy schreibt keine Zugriffsprotokolle (kein `log`-Eintrag im Caddyfile); für die Docker-Container-Logs ist in deploy/docker-compose.yml keine Rotation/Begrenzung konfiguriert (Standard json-file ohne Löschfrist) – z. B. logging max-size/max-file setzen und die resultierende Frist hier eintragen. -->

**Keine Tracking- oder Analyse-Dienste, keine Werbe-Cookies.** Schriften werden von unserem eigenen Server geladen, es werden keine Inhalte von Google Fonts oder vergleichbaren Diensten nachgeladen.

## 3. Cookies und lokale Speicherung

- **Sitzungs-Cookie** (`__Host-podo_session`, in der Entwicklung `podo_session`): nur nach der Anmeldung, technisch notwendig, HttpOnly, läuft nach höchstens 12 Stunden ab. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG, Art. 6 Abs. 1 lit. b DSGVO.
- **Hell/Dunkel-Einstellung** (`podo-theme` im lokalen Speicher des Browsers): speichert nur Ihre Anzeigewahl auf Ihrem Gerät, wird nicht an uns übertragen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **Navigation eingeklappt/ausgeklappt** (Cookie `podo_nav`, nur nach der Anmeldung in der Praxis-Software): merkt sich, ob die seitliche Navigation eingeklappt ist, damit die Seite gleich richtig angezeigt wird. Enthält nur den Wert „eingeklappt“ bzw. „offen“, wird mit jedem Seitenaufruf an unseren Server übertragen und nicht ausgewertet; Laufzeit 1 Jahr. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **App-Dateien im Browser-Speicher** (Service Worker und Cache `podo-static-…`, nur in der Praxis-Software): damit PodoHero als App installiert werden kann und ohne Verbindung einen Hinweis zeigt, legt der Browser Programmdateien (Skripte, Stylesheets, Schriften, Symbole) und eine Offline-Hinweisseite ab. Darin sind keine personenbezogenen Daten und keine Praxis- oder Patientendaten. Der Speicher wird bei jeder neuen Version ersetzt und lässt sich jederzeit über die Einstellungen des Browsers löschen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **Hinweis „App installieren“ ausgeblendet** (`podo-install-hint` im lokalen Speicher des Browsers): merkt sich nur, dass Sie den Hinweis geschlossen haben, wird nicht an uns übertragen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.

## 4. Registrierung und Nutzung durch Praxen

Wenn Sie eine Praxis registrieren oder als Mitarbeitende/r ein Konto erhalten, verarbeiten wir:

- Name, E-Mail-Adresse, Passwort (nur als sicherer Hash, Argon2id), optional das Geheimnis für die Zwei-Faktor-Anmeldung (verschlüsselt)
- Praxisdaten (Name, Anschrift, Kontaktdaten, Steuerangaben für Rechnungen)
- Sicherheits- und Zugriffsprotokoll (Anmeldungen, Zugriffe auf Akten, Exporte, Änderungen von Einstellungen) mit Zeitpunkt, Benutzer und IP-Adresse

- **Zweck:** Bereitstellung des Dienstes, Vertragserfüllung, Datensicherheit
- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag), Art. 6 Abs. 1 lit. c und f DSGVO (Datensicherheit nach Art. 32 DSGVO)
- **Speicherdauer:** für die Dauer des Vertrags; nach Kündigung Löschung nach 30 Tagen Karenzzeit (siehe [AGB](/agb) § 9). Rechnungen an die Praxis bewahren wir nach den steuerrechtlichen Fristen auf.

## 5. Abrechnung des Abonnements

Für die Abrechnung des Abonnements setzen wir den Zahlungsdienstleister Stripe Payments Europe Ltd., 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, Irland, ein. Dabei werden Rechnungs- und Zahlungsdaten der Praxis verarbeitet, **keine Patientendaten**. Rechtsgrundlage: Art. 6 Abs. 1 lit. b und c DSGVO. Stripe kann Daten auch an verbundene Unternehmen in den USA übermitteln; Grundlage ist die Zertifizierung nach dem EU-U.S. Data Privacy Framework (Angemessenheitsbeschluss, Art. 45 DSGVO) und ergänzend EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO). Stripe ist für die Zahlungsabwicklung eigenständig Verantwortlicher; Hinweise: https://stripe.com/de/privacy.

## 6. Kontaktaufnahme

Wenn Sie uns per E-Mail kontaktieren, verarbeiten wir Ihre Angaben zur Bearbeitung der Anfrage (Art. 6 Abs. 1 lit. b bzw. f DSGVO) und löschen sie, wenn die Anfrage erledigt ist und keine Aufbewahrungspflichten bestehen.

## 6a. Vertrieb / Kontaktaufnahme mit Praxen {#vertrieb}

Wir sprechen podologische Praxen und Praxen für medizinische Fußpflege auf PodoHero an. Verantwortlich ist der in Abschnitt 1 Genannte.

- **Quellen:** öffentlich zugängliche Geschäftsangaben, insbesondere Praxis-Websites und deren Impressum sowie OpenStreetMap; außerdem Ihre Anfrage an uns, ein persönlicher Kontakt (z. B. auf einer Messe) oder ein Import aus solchen Quellen – die Quelle speichern wir zu jedem Eintrag.
- **Daten:** Name der Praxis, geschäftliche E-Mail-Adresse, Website, Anschrift (Straße, Postleitzahl, Ort) und Entfernung zu unserem Standort; ggf. Telefonnummer und Ansprechpartner:in (nur aus Ihrer Anfrage, aus manueller Erfassung oder aus einem Import mit Quellenangabe); Versand- und Antwortverlauf, Notizen zum Kontakt und der Vermerk über Ihre Einwilligung (Wortlaut, Kanal, Datum). Praxisnamen von Einzelpraxen können den Namen der Inhaberin bzw. des Inhabers enthalten. Unsere automatische Suche (OpenStreetMap, Praxis-Websites) übernimmt keine Ansprechpartner:innen und keine Telefonnummern.
- **Zweck:** Kontaktaufnahme per E-Mail zu PodoHero nach Ihrer Einwilligung sowie Abgleich bei einer späteren Anfrage (damit wir Sie zuordnen und Doppelungen vermeiden können). Werbe-E-Mails senden wir nur, wenn Sie vorher ausdrücklich in Informationen per E-Mail eingewilligt haben (z. B. durch eine Anfrage mit dem Wunsch nach weiteren Informationen per E-Mail oder durch eine dokumentierte Zustimmung auf einer Messe). Jede E-Mail nennt die Quelle Ihrer Kontaktdaten.
- **Rechtsgrundlage:** für die E-Mail-Ansprache Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 7 Abs. 2 Nr. 2 UWG); für die reine Speicherung der öffentlich zugänglichen Geschäftsangaben bis zu einer Anfrage bzw. Einwilligung unser berechtigtes Interesse an der Gewinnung von Kundinnen und Kunden (Art. 6 Abs. 1 lit. f DSGVO).
- **Speicherdauer:** Einträge ohne Einwilligung löschen wir spätestens 12 Monate nach der letzten Aktivität, Einträge mit Einwilligung spätestens 24 Monate nach dem letzten Kontakt. Melden Sie sich ab oder widersprechen Sie, löschen wir Ihren Eintrag samt Verlauf und Notizen sofort.
- **Sperrliste:** Damit wir Sie danach nicht erneut ansprechen, speichern wir Ihre E-Mail-Adresse nur als nicht umkehrbaren Prüfwert (kein Klartext) mit Datum und Anlass. Rechtsgrundlage ist unser berechtigtes Interesse, Ihren Widerspruch dauerhaft zu beachten (Art. 6 Abs. 1 lit. f DSGVO). Die Sperrliste speichern wir, solange wir Vertriebs-E-Mails versenden; danach wird sie gelöscht.
- **Empfänger:** Für den Versand der E-Mails setzen wir einen E-Mail-Versanddienstleister als Auftragsverarbeiter ein (siehe Abschnitt 7 und [Unterauftragnehmer](/unterauftragnehmer)).
- **Ihre Rechte:** Sie können der Verarbeitung jederzeit widersprechen (Art. 21 DSGVO) und eine Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen – über den Abmeldelink in jeder E-Mail, durch Antwort mit „Abmelden“ oder per E-Mail an die oben genannte Adresse. Die übrigen Rechte nach Abschnitt 8 gelten entsprechend.

## 7. Empfänger

Wir setzen sorgfältig ausgewählte Dienstleister ein, die Daten nur nach unserer Weisung verarbeiten, darunter einen E-Mail-Versanddienstleister für System- und Vertriebs-E-Mails. Die aktuelle Liste finden Sie unter [Unterauftragnehmer](/unterauftragnehmer). Eine Verwendung von Daten zum Training von KI-Modellen findet nicht statt.

## 8. Ihre Rechte

Sie haben das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO). Erteilte Einwilligungen können Sie jederzeit mit Wirkung für die Zukunft widerrufen.

Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, z. B. bei der für uns zuständigen Behörde: Die Landesbeauftragte für den Datenschutz und für das Recht auf Akteneinsicht Brandenburg, Stahnsdorfer Damm 77, 14532 Kleinmachnow, E-Mail: poststelle@lda.brandenburg.de.

## 9. Sicherheit

Die Übertragung ist durchgehend mit TLS verschlüsselt. Wie wir Daten in der Anwendung schützen, beschreiben wir auf der Seite [Sicherheit](/sicherheit).
