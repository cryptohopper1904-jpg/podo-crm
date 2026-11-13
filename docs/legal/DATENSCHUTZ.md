# Datenschutzerklärung

> **Entwurf – vor Verwendung anwaltlich prüfen lassen.** Diese Vorlage ist keine Rechtsberatung.
>
> Version 0.3 · Stand 13.11.2026

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

Wir sprechen podologische Praxen und Praxen für medizinische Fußpflege auf PodoHero an.

- **Quellen:** öffentlich zugängliche Geschäftsangaben, insbesondere Praxis-Websites und deren Impressum sowie OpenStreetMap, oder Ihre eigene Anfrage an uns.
- **Daten:** Name der Praxis, geschäftliche E-Mail-Adresse, Website, Postleitzahl, Ort und Entfernung zu unserem Standort; ggf. Notizen zum Kontakt und die Dokumentation Ihrer Einwilligung. Praxisnamen von Einzelpraxen können den Namen der Inhaberin bzw. des Inhabers enthalten. Ansprechpartner und Telefonnummern erheben wir aus diesen Quellen nicht.
- **Zweck:** Kontaktaufnahme per E-Mail zu PodoHero. Werbe-E-Mails senden wir nur, wenn Sie vorher ausdrücklich eingewilligt haben (z. B. durch Ihre Anfrage oder eine dokumentierte Einwilligung auf einer Messe).
- **Rechtsgrundlage:** für die E-Mail-Ansprache Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 7 Abs. 2 Nr. 2 UWG); für die reine Speicherung der öffentlich zugänglichen Geschäftsangaben bis zu einer Anfrage bzw. Einwilligung unser berechtigtes Interesse an der Gewinnung von Kundinnen und Kunden (Art. 6 Abs. 1 lit. f DSGVO).
- **Speicherdauer:** Einträge ohne Kontakt löschen wir spätestens nach 24 Monaten. Bei Widerspruch oder Abmeldung löschen wir die Kontaktdaten bzw. sperren die Adresse: Damit wir Sie nicht erneut ansprechen, bleibt nur die E-Mail-Adresse mit dem Vermerk „abgemeldet“ auf unserer Sperrliste (Art. 6 Abs. 1 lit. c bzw. f DSGVO).
- **Ihre Rechte:** Sie können der Verarbeitung jederzeit widersprechen (Art. 21 DSGVO) und eine Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen – über den Abmeldelink in jeder E-Mail, durch Antwort mit „Abmelden“ oder per E-Mail an die oben genannte Adresse. Die übrigen Rechte nach Abschnitt 8 gelten entsprechend.

## 7. Empfänger

Wir setzen sorgfältig ausgewählte Dienstleister ein, die Daten nur nach unserer Weisung verarbeiten. Die aktuelle Liste finden Sie unter [Unterauftragnehmer](/unterauftragnehmer). Eine Verwendung von Daten zum Training von KI-Modellen findet nicht statt.

## 8. Ihre Rechte

Sie haben das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO). Erteilte Einwilligungen können Sie jederzeit mit Wirkung für die Zukunft widerrufen.

Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, z. B. bei der für uns zuständigen Behörde: Die Landesbeauftragte für den Datenschutz und für das Recht auf Akteneinsicht Brandenburg, Stahnsdorfer Damm 77, 14532 Kleinmachnow, E-Mail: poststelle@lda.brandenburg.de.

## 9. Sicherheit

Die Übertragung ist durchgehend mit TLS verschlüsselt. Wie wir Daten in der Anwendung schützen, beschreiben wir auf der Seite [Sicherheit](/sicherheit).
