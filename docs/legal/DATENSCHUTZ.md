# Datenschutzerklärung

> **Entwurf – vor Verwendung anwaltlich prüfen lassen.** Diese Vorlage ist keine Rechtsberatung.
>
> Version 0.7 · Stand 19.11.2026

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

<!-- TODO (Betreiber): Speicherdauer der Server-Protokolle erst angeben, wenn belegt. Stand 16.11.2026: Container-Logs werden per logrotate nach 7 Tagen gelöscht (deploy/log-retention.sh), ABER (1) im Subdomain-Modus erfasst das die Zugriffslogs des vorhandenen Host-Caddy nicht (BETRIEB.md 4.4 – prüfen, ob dort ein `log`-Eintrag besteht, ggf. `roll_keep_for 168h`), und (2) für den Server sind Hetzner-Backups aktiv (Backup-Fenster 02–06 Uhr, bis zu 7 Sicherungen) – Logs liegen damit bis zu ca. 14 Tage in Sicherungen. Danach Frist eintragen (z. B. „höchstens 14 Tage einschließlich Sicherungen“). -->

### Erklärvideo auf der Startseite

Das Erklärvideo auf unserer Startseite liegt auf unserem eigenen Server und wird nicht über YouTube, Vimeo oder andere Video-Plattformen eingebunden. Beim Aufruf der Startseite lädt Ihr Browser nur das Vorschaubild. Videodatei und Untertitel ruft er erst ab, wenn Sie auf „Abspielen“ klicken. Dabei verarbeitet unser Server dieselben technisch notwendigen Daten wie beim Aufruf der Website (IP-Adresse, Datum und Uhrzeit, aufgerufene Datei, übertragene Datenmenge, Browser-Kennung); weil das Video in Teilstücken geladen wird, können dabei mehrere Abrufe entstehen. Wir setzen dafür keine Cookies, nutzen keine Analyse- oder Tracking-Dienste und werten nicht aus, ob oder wie lange Sie das Video ansehen. Abgesehen vom üblichen Zwischenspeicher (Cache) Ihres Browsers wird nichts auf Ihrem Gerät gespeichert.

- **Zweck:** Bereitstellung des Videos auf Ihre Anforderung
- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse, unser Angebot verständlich zu erklären); Zwischenspeicherung im Browser: § 25 Abs. 2 Nr. 2 TDDDG
- **Empfänger:** unser Hosting-Dienstleister als Auftragsverarbeiter (siehe Abschnitt 7 und [Unterauftragnehmer](/unterauftragnehmer))
- **Speicherdauer:** wie beim Aufruf der Website (siehe oben)

Die Sprecherstimme wurde vorab einmalig mit einem KI-Dienst erzeugt; beim Abspielen findet keine KI-Verarbeitung statt und es werden keine Daten an einen KI-Anbieter übermittelt. Alle im Video gezeigten Namen, Telefonnummern und Gesundheitsangaben sind erfundene Demo-Daten.

**Keine Tracking- oder Analyse-Dienste, keine Werbe-Cookies.** Schriften werden von unserem eigenen Server geladen, es werden keine Inhalte von Google Fonts oder vergleichbaren Diensten nachgeladen.

## 3. Cookies und lokale Speicherung

- **Sitzungs-Cookie** (`__Host-podo_session`, in der Entwicklung `podo_session`): nur nach der Anmeldung, technisch notwendig, HttpOnly, läuft nach höchstens 12 Stunden ab. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG, Art. 6 Abs. 1 lit. b DSGVO.
- **Hell/Dunkel-Einstellung** (`podo-theme` im lokalen Speicher des Browsers): speichert nur Ihre Anzeigewahl auf Ihrem Gerät, wird nicht an uns übertragen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **Navigation eingeklappt/ausgeklappt** (Cookie `podo_nav`, nur nach der Anmeldung in der Praxis-Software): merkt sich, ob die seitliche Navigation eingeklappt ist, damit die Seite gleich richtig angezeigt wird. Enthält nur den Wert „eingeklappt“ bzw. „offen“, wird mit jedem Seitenaufruf an unseren Server übertragen und nur für die Darstellung der Navigation verwendet; Laufzeit 1 Jahr. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **App-Dateien im Browser-Speicher** (Service Worker und Cache `podo-static-…`, nur in der Praxis-Software einschließlich der Anmeldeseiten): damit PodoHero als App installiert werden kann und ohne Verbindung einen Hinweis zeigt, legt der Browser Programmdateien (Skripte, Stylesheets, Schriften, Symbole) und eine Offline-Hinweisseite ab. Darin sind keine personenbezogenen Daten und keine Praxis- oder Patientendaten. Der Speicher wird bei jeder neuen Version ersetzt und lässt sich jederzeit über die Einstellungen des Browsers löschen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.
- **Hinweis „App installieren“ ausgeblendet** (`podo-install-hint` im lokalen Speicher des Browsers): merkt sich nur, dass Sie den Hinweis geschlossen haben, wird nicht an uns übertragen. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG.

## 4. Registrierung und Nutzung durch Praxen

Wenn Sie eine Praxis registrieren oder als Mitarbeitende/r ein Konto erhalten, verarbeiten wir:

- Name, E-Mail-Adresse, Passwort (nur als sicherer Hash, Argon2id), optional das Geheimnis für die Zwei-Faktor-Anmeldung (verschlüsselt)
- Praxisdaten (Name, Anschrift, Kontaktdaten, Steuerangaben für Rechnungen)
- Sicherheits- und Zugriffsprotokoll (Anmeldungen, Zugriffe auf Akten, Exporte, Änderungen von Einstellungen) mit Zeitpunkt, Benutzer und IP-Adresse

- **Zweck:** Bereitstellung des Dienstes, Vertragserfüllung, Datensicherheit
- **Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Vertrag), Art. 6 Abs. 1 lit. c und f DSGVO (Datensicherheit nach Art. 32 DSGVO)
- **Speicherdauer:** für die Dauer des Vertrags; danach höchstens 12 Monate im Nur-Lesen-Modus, auf Löschantrag nach 30 Tagen Karenzzeit (siehe [AGB](/agb) § 9). Verschlüsselte Datensicherungen werden spätestens 30 Tage nach der Löschung gelöscht. Rechnungen an die Praxis bewahren wir nach den steuerrechtlichen Fristen auf.

## 5. Abrechnung des Abonnements

Für die Abrechnung des Abonnements setzen wir den Zahlungsdienstleister Stripe Payments Europe Ltd., 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, Irland, ein. Dabei werden Rechnungs- und Zahlungsdaten der Praxis verarbeitet, **keine Patientendaten**. Rechtsgrundlage: Art. 6 Abs. 1 lit. b und c DSGVO. Stripe kann Daten auch an verbundene Unternehmen in den USA übermitteln; Grundlage ist die Zertifizierung nach dem EU-U.S. Data Privacy Framework (Angemessenheitsbeschluss, Art. 45 DSGVO) und ergänzend EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO). Stripe ist für die Zahlungsabwicklung eigenständig Verantwortlicher; Hinweise: https://stripe.com/de/privacy.

## 6. Kontaktaufnahme

Wenn Sie uns per E-Mail kontaktieren, verarbeiten wir Ihre Angaben zur Bearbeitung der Anfrage (Art. 6 Abs. 1 lit. b bzw. f DSGVO) und löschen sie, wenn die Anfrage erledigt ist und keine Aufbewahrungspflichten bestehen.

## 6a. Vertrieb / Kontaktaufnahme mit Praxen {#vertrieb}

Wir sprechen podologische Praxen und Praxen für medizinische Fußpflege auf PodoHero an. Verantwortlich ist der in Abschnitt 1 Genannte.

- **Quellen:** öffentlich zugängliche Geschäftsangaben, insbesondere Praxis-Websites und deren Impressum sowie OpenStreetMap; außerdem Ihre Anfrage an uns, ein persönlicher Kontakt (z. B. auf einer Messe) oder ein Import aus solchen Quellen. Zu jedem Eintrag speichern wir die Quelle und das Abrufdatum.
- **Daten:** Name der Praxis (bei Einzelpraxen damit auch der Name der Inhaberin bzw. des Inhabers), geschäftliche E-Mail-Adresse, Website, Anschrift (Straße, Postleitzahl, Ort) und Entfernung zu unserem Standort; ggf. Telefonnummer und Ansprechpartner:in; Quelle und Abrufdatum; Datum und Inhalt unserer Schreiben, Ihre Antwort und Notizen zum Kontakt; je Kanal (E-Mail, Telefon) der Vermerk über eine Einwilligung (Datum, Erteilungsweg, Wortlaut bzw. Nachweis) und ggf. deren Widerruf. Unsere automatische Suche (OpenStreetMap, Praxis-Websites) übernimmt keine Ansprechpartner:innen und keine Telefonnummern.
- **Telefonnummern:** Eine Telefonnummer, die z. B. im Impressum veröffentlicht ist und manuell oder per Import erfasst wurde, speichern wir, um Sie bei einem Rückruf zuordnen zu können. Angezeigt und für Anrufe genutzt wird sie erst, wenn Sie in Anrufe eingewilligt haben oder Kundin bzw. Kunde sind.
- **Zweck und Rechtsgrundlage:**
  - **Briefwerbung:** Wir informieren Praxen per Brief über PodoHero, ordnen eine Antwort zu und vermeiden doppelte Anschreiben. Rechtsgrundlage ist unser berechtigtes Interesse an der Gewinnung von Kundinnen und Kunden (Art. 6 Abs. 1 lit. f DSGVO). Dem ersten Brief liegt ein Datenschutzhinweis nach Art. 14 DSGVO bei, spätestens einen Monat nach dem Abruf der Daten.
  - **E-Mail und Telefon:** Werbung per E-Mail nur mit Ihrer vorherigen ausdrücklichen Einwilligung in E-Mails (§ 7 Abs. 2 Nr. 2 UWG), Werbeanrufe nur mit Ihrer vorherigen ausdrücklichen Einwilligung in Anrufe (§ 7 Abs. 2 Nr. 1 UWG); Rechtsgrundlage ist dann Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO). Die Einwilligung gilt nur für den Kanal, für den sie erteilt wurde. Auf eine „mutmaßliche Einwilligung“ stützen wir uns nicht; Kaltanrufe finden nicht statt. Jede E-Mail nennt die Quelle Ihrer Kontaktdaten.
- **Speicherdauer:** Ohne Einwilligung löschen wir einen Eintrag automatisch an seinem Löschdatum: 6 bis 12 Monate nach der Erhebung (je Eintrag festgelegt, Standard 12 Monate). Unsere Schreiben und Ihre Antworten verlängern diese Frist nicht. Haben Sie in Werbe-E-Mails oder Werbeanrufe eingewilligt, speichern wir den Eintrag bis 24 Monate nach Ihrer letzten Antwort oder Einwilligung; widerrufen Sie, löschen wir am Löschdatum oder, wenn es schon vorbei ist, umgehend. Werden Sie Kundin oder Kunde, gelten die Fristen unseres Vertrags und die gesetzlichen Aufbewahrungsfristen. Melden Sie sich ab oder widersprechen Sie, löschen wir Ihren Eintrag samt Verlauf und Notizen sofort. Einträge aus der Zeit vor dieser Regel werden frühestens 30 Tage nach ihrer Einführung gelöscht.
- **Sperrliste:** Damit wir Sie nach einem Widerspruch bzw. einer Abmeldung nicht erneut ansprechen, speichern wir Ihre E-Mail-Adresse, den Host Ihrer Website sowie Praxisname und Postleitzahl nur noch als HMAC-Prüfwert (kein Klartext, nicht umkehrbar) mit Datum und Anlass. Diese Prüfwerte sind pseudonymisiert und bleiben personenbezogene Daten. Rechtsgrundlage ist unser berechtigtes Interesse, Ihren Widerspruch dauerhaft zu beachten (Art. 6 Abs. 1 lit. f DSGVO). Wir speichern die Sperrliste, solange wir Vertriebsschreiben (Briefe, E-Mails) versenden; danach wird sie gelöscht.
- **Empfänger:** Hosting in Deutschland; für den Versand der E-Mails einen E-Mail-Versanddienstleister als Auftragsverarbeiter (siehe Abschnitt 7 und [Unterauftragnehmer](/unterauftragnehmer)). Wir verkaufen oder vermieten Ihre Daten nicht.
- **Ihre Rechte:** Sie können der Verwendung Ihrer Daten für Werbung jederzeit ohne Angabe von Gründen widersprechen (Art. 21 Abs. 2 DSGVO) und eine Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3 DSGVO) – über den Abmeldelink in jeder E-Mail, durch Antwort mit „Abmelden“, per Brief oder per E-Mail an die oben genannte Adresse. Die übrigen Rechte nach Abschnitt 8 gelten entsprechend.

## 7. Empfänger

Wir setzen sorgfältig ausgewählte Dienstleister ein, die Daten nur nach unserer Weisung verarbeiten, darunter einen E-Mail-Versanddienstleister für System- und Vertriebs-E-Mails. Die aktuelle Liste finden Sie unter [Unterauftragnehmer](/unterauftragnehmer). Eine Verwendung von Daten zum Training von KI-Modellen findet nicht statt.

## 8. Ihre Rechte

Sie haben das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO). Erteilte Einwilligungen können Sie jederzeit mit Wirkung für die Zukunft widerrufen.

Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, z. B. bei der für uns zuständigen Behörde: Die Landesbeauftragte für den Datenschutz und für das Recht auf Akteneinsicht Brandenburg, Stahnsdorfer Damm 77, 14532 Kleinmachnow, E-Mail: poststelle@lda.brandenburg.de.

## 9. Sicherheit

Die Übertragung ist durchgehend mit TLS verschlüsselt. Wie wir Daten in der Anwendung schützen, beschreiben wir auf der Seite [Sicherheit](/sicherheit).
