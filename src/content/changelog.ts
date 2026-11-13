/**
 * Neuigkeiten („Neu in PodoHero“): erscheinen nach jeder Anmeldung als Popup und dauerhaft unter /neuigkeiten.
 *
 * Regeln für neue Einträge:
 *  - Neueste Einträge OBEN. `id` = Datum (JJJJ-MM-TT), bei mehreren am selben Tag mit Zusatz („2026-11-09-b“).
 *    Die id wird als Text verglichen – sie muss also mit jedem neuen Eintrag größer werden.
 *  - Einfaches Deutsch, Nutzen für die Praxis statt Technik.
 *  - `audience`: "all" (Standard) = alle; "owner" = nur Inhaber:innen; "platform" = nur Plattform-Betreiber.
 *  - Erst eintragen, wenn die Funktion auf main live ist (siehe Entwürfe ganz unten).
 */

export type ChangelogTag = "neu" | "verbessert" | "behoben";
export type ChangelogAudience = "all" | "owner" | "platform";

export type ChangelogItem = { text: string; tag: ChangelogTag; href?: string };

export type ChangelogEntry = {
  id: string;
  /** ISO-Datum (JJJJ-MM-TT) */
  date: string;
  title: string;
  items: ChangelogItem[];
  audience?: ChangelogAudience;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-11-13-h",
    date: "2026-11-13",
    title: "Kalender: vollständige Ansicht und freie Termine finden",
    items: [
      { tag: "neu", text: "Im Kalender können Sie zwischen „Einfach“ (Terminliste wie bisher) und „Vollständig“ wählen: Tag, Woche und Monat mit Zeitachse wie in Outlook, in der Tagesansicht eine Spalte je Behandler:in. Ihre Wahl wird gemerkt.", href: "/kalender" },
      { tag: "neu", text: "Freie Zeit im Kalender anklicken (oder einen Tag in der Monatsansicht) – das Formular „Neuer Termin“ ist mit Datum, Uhrzeit und Behandler:in vorausgefüllt.", href: "/kalender" },
      { tag: "neu", text: "„Freien Termin finden“: ab sofort, morgen oder in 1, 2, 4 oder 6 Wochen die nächsten freien Zeiten anzeigen – passend zu Leistung/Dauer und Behandler:in (oder egal wer). Termine, Abwesenheiten und Arbeitszeiten werden berücksichtigt.", href: "/kalender" },
      { tag: "verbessert", text: "Belegte Zeiten und Abwesenheiten sind als „nicht verfügbar“ markiert. Beim Eintragen und Verschieben warnt PodoHero sofort, wenn die Behandler:in schon einen Termin hat (mit Uhrzeit) oder abwesend ist – gespeichert wird dann nur nach ausdrücklicher Bestätigung." },
    ],
  },
  {
    id: "2026-11-13-f",
    date: "2026-11-13",
    title: "Sammelrechnung: Quittungen der Patient:in auswählen",
    items: [
      { tag: "neu", text: "Bei „Sammelrechnung“ erscheinen nach der Wahl der Patient:in direkt alle offenen Quittungen (für die Sammelrechnung) zum Anhaken. Gewählte Quittungen kommen mit ihrer Behandlung als Position auf die Sammelrechnung, der bereits bezahlte Betrag wird angerechnet – „Alle wählen“ oder einzeln abwählen.", href: "/rechnungen/neu" },
      { tag: "verbessert", text: "Hinweis bei normalen Quittungen: Sie sind bereits fertige, bezahlte Belege und werden nicht noch einmal in die Sammelrechnung übernommen." },
    ],
  },
  {
    id: "2026-11-13-e",
    date: "2026-11-13",
    title: "USt-Wächter einmal bestätigen statt bei jeder Rechnung",
    audience: "owner",
    items: [
      { tag: "neu", text: "Unter Einstellungen → Praxisdaten → Belege können Sie einmalig bestätigen, dass Ihre 0-%-Leistungen Heilbehandlungen mit therapeutischem Ziel sind. Dann ist der Haken auf neuen Rechnungen schon gesetzt. Bei kosmetischen Leistungen auf der Rechnung 19 % wählen – die Bestätigung wird weiterhin je Rechnung gespeichert.", href: "/einstellungen/praxis" },
    ],
  },
  {
    id: "2026-11-13-d",
    date: "2026-11-13",
    title: "Patient:innen statt Kund:innen",
    audience: "all",
    items: [
      { tag: "verbessert", text: "PodoHero spricht jetzt überall von Patient:innen statt Kund:innen – in Menü, Patientenakte, Patientenportal, Suche und Hinweisen. Links und Lesezeichen funktionieren weiter wie bisher.", href: "/kunden" },
    ],
  },
  {
    id: "2026-11-13-c",
    date: "2026-11-13",
    title: "Zahlungsziel nach Ihrer Gewohnheit",
    audience: "owner",
    items: [
      { tag: "neu", text: "Standard-Zahlungsziel: Unter Einstellungen → Praxisdaten → Belege legen Sie fest, wie viele Tage neue Rechnungen Zeit haben – oder 0 für „Zahlbar sofort“. Auf jeder Rechnung lässt es sich weiter ändern.", href: "/einstellungen/praxis" },
      { tag: "verbessert", text: "Termin-QR auf der Rechnung ohne langen Link darunter – der QR-Code reicht." },
    ],
  },
  {
    id: "2026-11-13-b",
    date: "2026-11-13",
    title: "Ihr Logo auf Rechnungen, QR-Code zum Bezahlen und Anamnese am iPad",
    items: [
      { tag: "neu", text: "Logos im Profil: Laden Sie Ihr vollständiges Logo und Ihr Zeichen hoch. Das Logo steht oben auf jeder Rechnung und in Ihren E-Mails, das Zeichen dezent auf Anamnesebögen, Ausdrucken und Quittungen.", href: "/einstellungen/praxis" },
      { tag: "neu", text: "QR-Code zum Bezahlen: Auf offenen Rechnungen steht ein GiroCode. Ihre Patient:innen scannen ihn mit der Banking-App – Betrag, IBAN und Rechnungsnummer sind schon ausgefüllt. Bar bezahlte Quittungen bekommen keinen." },
      { tag: "neu", text: "Nächsten Termin buchen: Auf Wunsch zeigt jede Rechnung einen QR-Code zu Ihrer Online-Buchung – PodoHero, Doctolib oder ein eigener Link.", href: "/einstellungen/praxis" },
      { tag: "verbessert", text: "Neues Rechnungsdesign: Logo oben, Kasten mit Rechnungsnummer und Terminvereinbarung (auch WhatsApp), „Rechnung zur Behandlung am …“, Zahlungshinweis passend zur Zahlart und eine Fußzeile mit Bankverbindung, Steuernummer und Berufsbezeichnung." },
      { tag: "neu", text: "Anamnesebogen am iPad: Datum, Name und Patientennummer sind schon ausgefüllt – direkt aus der Patientenakte oder über „Anamnese“ beim heutigen Termin. Große Felder zum Antippen, dazu eine Druckfassung mit gleichem Kopf.", href: "/heute" },
    ],
  },
  {
    id: "2026-11-13",
    date: "2026-11-13",
    title: "Rechnungen schneller schreiben",
    items: [
      { tag: "neu", text: "Kürzel-Eingabe: In jeder Rechnungsposition einfach das Kürzel der Leistung tippen (z. B. „PK“) – Leistung und Preis stehen sofort drin. Mit Enter geht es direkt zur nächsten Position. Das Auswahlmenü daneben bleibt wie gewohnt.", href: "/rechnungen/neu" },
    ],
  },
  {
    id: "2026-11-09-h",
    date: "2026-11-09",
    title: "Termine verschieben, Rechnung und Quittung direkt aus dem Termin",
    items: [
      { tag: "neu", text: "Termin verschieben: Uhrzeit im Kalender antippen, neues Datum und neue Uhrzeit wählen – fertig. Termine aus Doctolib oder dem Kalender-Abo ändern Sie weiter dort, sie kommen automatisch zurück.", href: "/kalender" },
      { tag: "neu", text: "Rechnung direkt aus dem Termin oder der Behandlung: Die Leistungen sind schon eingetragen, weitere Positionen ergänzen Sie vor dem Ausstellen.", href: "/kalender" },
      { tag: "neu", text: "Quittung für die Sammelrechnung: Zahlt jemand gleich bar oder mit Karte, bekommt er sofort eine Quittung. Der Betrag wird auf der Sammelrechnung zum Jahresende automatisch abgezogen." },
      { tag: "neu", text: "Erinnerung zum Jahresende: Ab Dezember zeigt „Heute“, wer noch eine Sammelrechnung braucht – mit einem Klick ist sie vorbereitet.", href: "/rechnungen/sammelrechnungen" },
    ],
  },
  {
    id: "2026-11-09-g",
    date: "2026-11-09",
    title: "Touren & Fahrtenbuch",
    items: [
      { tag: "neu", text: "Hausbesuche als Tour planen: PodoHero schlägt eine sinnvolle Reihenfolge vor und zeigt die Strecke – ab Praxis, Zuhause oder vom letzten Patienten.", href: "/touren" },
      { tag: "neu", text: "„Ich fahre los“: Ein Tipp genügt, die Kilometer werden automatisch ins Fahrtenbuch eingetragen – praktisch für die Steuer und fürs Wegegeld.", href: "/touren" },
      { tag: "neu", text: "Startorte, Fahrzeug und km-Satz legen Sie unter Einstellungen → Fahrten & Startorte fest." },
    ],
  },
  {
    id: "2026-11-09-f",
    date: "2026-11-09",
    title: "Doctolib-Termine im Kalender",
    items: [
      { tag: "neu", text: "Kalender-Abo: Termine aus Doctolib erscheinen automatisch in Ihrem PodoHero-Kalender – über Ihren Google-Kalender, ohne doppeltes Eintragen.", href: "/einstellungen/kalender-abo" },
    ],
  },
  {
    id: "2026-11-09-e",
    date: "2026-11-09",
    title: "Nur Privat & Selbstzahler",
    audience: "owner",
    items: [
      { tag: "neu", text: "Neuer Modus „nur Privat & Selbstzahler“: Behandeln Sie keine Kassenpatient:innen, blendet PodoHero Verordnungen und Kassenabrechnung einfach aus – alles wird übersichtlicher.", href: "/einstellungen/praxis" },
    ],
  },
  {
    id: "2026-11-09-d",
    date: "2026-11-09",
    title: "Schneller eintippen, gezieltere News",
    items: [
      { tag: "neu", text: "Adressen vervollständigen sich beim Tippen: Straße eingeben, Vorschlag antippen – Postleitzahl und Ort stehen sofort richtig da.", href: "/kunden/neu" },
      { tag: "verbessert", text: "Die News zeigen jetzt nur noch Meldungen, die für Podologie und Fußpflege wirklich wichtig sind – ohne allgemeine Gesundheitsthemen.", href: "/news" },
    ],
  },
  {
    id: "2026-11-09-c",
    date: "2026-11-09",
    title: "Für Betreiber: Plattform-Konsole",
    audience: "platform",
    items: [
      { tag: "neu", text: "Die Plattform-Konsole zeigt, wie PodoHero genutzt wird – Praxen, Anmeldungen und Aktivität auf einen Blick, ohne Einsicht in Patientendaten.", href: "/plattform" },
      { tag: "neu", text: "Eine Demo-Praxis mit Beispieldaten lässt sich mit einem Klick anlegen und zurücksetzen – ideal für Vorführungen. Zwischen Praxis und Plattform wechseln Sie oben im Menü.", href: "/plattform" },
      { tag: "verbessert", text: "Testphase: Praxen können während des Tests jetzt bis zu 10 Plätze für ihr Team bekommen.", href: "/plattform" },
    ],
  },
  {
    id: "2026-11-09-b",
    date: "2026-11-09",
    title: "Neu für Inhaber:innen",
    audience: "owner",
    items: [
      { tag: "neu", text: "Eigene Praxis-Website als Zusatzmodul: Öffnungszeiten, Leistungen und Kontakt – fertig gestaltet und direkt mit Ihrer Online-Buchung verbunden.", href: "/einstellungen/website" },
      { tag: "verbessert", text: "Die Einstellungen sind jetzt in übersichtliche Gruppen sortiert – Sie finden schneller, was Sie suchen.", href: "/einstellungen" },
      { tag: "neu", text: "Patient:innen löschen oder anonymisieren: Wünscht jemand die Löschung seiner Daten, erledigen Sie das direkt in der Patientenakte unter „Bearbeiten“ – gesetzliche Aufbewahrungsfristen werden dabei beachtet.", href: "/kunden" },
    ],
  },
  {
    id: "2026-11-09",
    date: "2026-11-09",
    title: "Aus PodoCRM wird PodoHero",
    items: [
      { tag: "neu", text: "Neuer Name, neues Logo: Ihre Praxissoftware heißt jetzt PodoHero. Alles andere bleibt, wie Sie es kennen." },
      { tag: "neu", text: "Neue Startseite: Auf unserer Website sehen Interessierte jetzt auf einen Blick, was PodoHero alles kann." },
      { tag: "neu", text: "Zwei-Faktor-Anmeldung: Einfach den QR-Code mit einer Authenticator-App scannen – Ihr Konto ist damit deutlich besser geschützt. Für Inhaber:innen ist sie Pflicht.", href: "/einstellungen/sicherheit" },
      { tag: "neu", text: "„Passwort vergessen“: Sie können Ihr Passwort jetzt selbst per E-Mail zurücksetzen – ohne beim Support anzurufen." },
      { tag: "verbessert", text: "Online-Buchung: Patient:innen sehen nur noch Termine, die zu Ihren Arbeitszeiten passen – Urlaub und freie Tage werden automatisch berücksichtigt." },
      { tag: "neu", text: "Kasse mit Tagesabschluss: Am Ende des Tages zählen Sie die Kasse und schließen mit einem Klick ab – der Abschlussbericht ist sofort fertig.", href: "/kasse" },
    ],
  },
];

// Kommende Einträge (beim Merge der jeweiligen Funktion freischalten)
// Zum Freischalten: Eintrag OBEN in CHANGELOG einfügen, id/Datum auf den Tag des Merges setzen.
//
