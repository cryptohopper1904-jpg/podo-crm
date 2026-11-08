# Datenschutz-Folgenabschätzung (Art. 35 DSGVO) – Gerüst

1. **Beschreibung der Verarbeitung:** siehe VVT Nr. 1–9; Besonderheit: Gesundheitsdaten (Art. 9), Fotos, KI-gestützte Transkription, SaaS für mehrere Praxen.
2. **Notwendigkeit/Verhältnismäßigkeit:** Doku gesetzlich vorgeschrieben; KI optional und abschaltbar; Pflichtfelder indikationsabhängig (Datensparsamkeit).
3. **Risiken (Auswahl):**
   | Risiko | Eintritt | Schwere | Maßnahme |
   |---|---|---|---|
   | Zugriff fremder Praxis (Mandantenfehler) | gering | hoch | RLS + App-Filter + Test |
   | Verlust/Diebstahl iPad | mittel | hoch | keine Daten lokal, MDM, Sperre, 2FA |
   | KI-Anbieter nutzt Daten zum Training | gering | hoch | EU, AVV, ZDR, Freigabeschalter, Redaktion |
   | Fehlerhafte KI-Strukturierung | mittel | mittel | Mensch prüft und bestätigt, Kennzeichnung „KI-unterstützt“ |
   | Datenverlust | gering | hoch | verschlüsselte Backups, Restore-Test |
   | Offenlegung in Google-Antworten | mittel | mittel | Filter gegen Gesundheitsbegriffe, Freigabe durch Mensch |
4. **Ergebnis:** mit Maßnahmen vertretbar – durch DSB zu bestätigen.
