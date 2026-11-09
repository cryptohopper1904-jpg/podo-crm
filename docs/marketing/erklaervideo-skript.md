# PodoHero – Erklärvideo: Sprechertext & Einblendungen

- **Datei:** `docs/marketing/podohero-erklaervideo.mp4` (1920×1080, H.264/AAC, ca. 2:01 min)
- **Hochkant-Schnitt (Social Media):** `docs/marketing/podohero-erklaervideo-9x16.mp4` (1080×1920)
- **Aufnahme:** echte App (Stand `main`), Demo-Praxis mit ausschließlich erfundenen Daten (Demo-Seed); Fotos sind Illustrationen.
- **Stimme:** KI-Sprecherin (OpenRouter `openai/gpt-audio`, Stimme „coral“), ruhig, Hochdeutsch.
- **Farben:** Petrol `#0b7f73` (Primär), Koralle `#f2715a` (Akzent); Schriften Space Grotesk / Inter.

| Zeit | Szene | Einblendung (Bauchbinde) | Sprechertext |
|---|---|---|---|
| 0:00 | Titelkarte: Logo, „Die Praxissoftware für Podologie“ | – | – |
| 0:02 | Startseite (Hero, Funktionsübersicht) | PodoHero · Die Praxissoftware für Podologie | Das ist PodoHero – die Praxissoftware für podologische Praxen in Deutschland. Eine Lösung für alles: vom ersten Anruf bis zum Tagesabschluss. |
| 0:14 | „Heute“-Übersicht: Termine, Diabetes-/Blutverdünner-Hinweise, Posteingang | Heute-Übersicht · Termine & Risiko-Hinweise auf einen Blick | Morgens öffnen Sie die Heute-Übersicht. Alle Termine des Tages, Risiko-Hinweise wie Diabetes oder Blutverdünner auf einen Blick – und neue Nachrichten mit KI-Antwortvorschlag. |
| 0:28 | iPad (Hochformat im Geräterahmen): Kundenakte → Behandlung dokumentieren, Leistung NS, Spange setzen, Pflichtfoto-Hinweis, Foto aufnehmen, Fußschema 2D + 3D, Befund, Abschließen | Doku am iPad · Fußschema 2D/3D & Pflichtfotos | Am Behandlungsstuhl dokumentieren Sie direkt auf dem iPad. Leistung antippen, Befunde im Fußschema markieren – in 2D oder in 3D. Die Foto-Checkliste erinnert an Pflichtfotos, etwa bei der Nagelkorrekturspange. Alle Fotos werden verschlüsselt gespeichert. |
| 0:47 | Kalender (Wochenansicht) → Online-Buchung `/buchen/<slug>` auf dem Smartphone | Kalender · Alle Termine – Tag und Woche / Online-Buchung · Ihre Kundschaft bucht rund um die Uhr | Ihre Kundschaft bucht online, rund um die Uhr. Leistung wählen, Termin aussuchen, fertig. Die Anfrage landet direkt bei Ihnen in der Praxis. |
| 1:02 | KI-Telefon: Testanruf (freie Termine, Rückrufwunsch, Gesprächsende) → Posteingang mit Rückrufbitte | KI-Telefon · Nimmt Anrufe an, während Sie behandeln | Und wenn das Telefon klingelt, während Sie behandeln? Der KI-Telefonassistent nennt freie Termine, nimmt Rückrufwünsche auf und legt alles in Ihren Posteingang. |
| 1:16 | Rechnung erstellen (Barzahlung) → Kasse: Zählprotokoll → Tagesabschluss (Z-Bon) | Abrechnung · Rechnung, Kasse & Tagesabschluss (Z-Bon) | Die Rechnung ist mit wenigen Klicks erstellt – bar, mit Karte oder per Überweisung. Abends zählen Sie die Kasse und machen den Tagesabschluss mit Z-Bon. |
| 1:31 | Verordnungen mit Fristen-Ampel, Filter „Frist kritisch“ | Verordnungen · Jede Frist im Blick – mit Ampel | Bei Heilmittelverordnungen behalten Sie jede Frist im Blick. Die Ampel zeigt sofort, wo der Behandlungsbeginn knapp wird. |
| 1:40 | Einstellungen → Website-Zusatz: veröffentlichen, Claim → öffentliche Praxis-Website | Praxis-Website · Ihre Website mit Online-Buchung inklusive | Und auf Wunsch erstellt PodoHero sogar Ihre Praxis-Website – mit Leistungen, Öffnungszeiten und Online-Buchung. |
| 1:49 | Endkarte: Logo, „Ihre Praxis läuft. Sie behandeln.“, „Jetzt 30 Tage kostenlos testen“, podo.algoverdict.com | – | PodoHero. Ihre Praxis läuft – Sie behandeln. Jetzt dreißig Tage kostenlos testen, auf podo punkt algoverdict punkt com. |

## Hinweise zur Produktion

- Aufnahme mit Playwright (`recordVideo`, 1920×1080, Zoom 125 %; iPad-Szene 1024×1366, Buchung 430×932), sichtbarer Cursor-Punkt, langsames Tippen.
- Die verpflichtende 2FA-Einrichtung der Inhaberin wurde vor der Aufnahme per Skript erledigt und ist nicht im Video zu sehen.
- Einzelne Szenen sind im Schnitt um bis zu 1,75× beschleunigt, damit Bild und Sprechertext zusammenpassen.
- Kleinere Abweichungen (Datum, Begrüßung „Guten Abend“) stammen aus dem Aufnahmezeitpunkt (9. November 2026).
