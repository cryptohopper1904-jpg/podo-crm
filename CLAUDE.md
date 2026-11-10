@AGENTS.md

<!-- fach-agenten:start (wird von claude-config/scripts/sync-agents.sh gepflegt; hier nicht von Hand ändern) -->
## Fach-Agenten

In `.claude/agents/` liegen 12 Fach-Agenten (Übersicht: `.claude/agents/README.txt`). Die Quelle ist das Repo `claude-config` (`agents/`); dort ändern und hierher kopieren, nicht hier einzeln anpassen.

**Sichtbar machen:** Vor jedem Aufruf eine Zeile im Chat, wer übernimmt und warum, z. B. `🎯 Agent: code-reviewer – prüft den Diff vor dem PR`. Arbeitest du ohne Agenten fachlich in einer dieser Rollen, beginne mit `🎯 Rolle: <Name>`.

**Pflicht-Durchläufe** (über das Agent-Tool, unabhängige Prüfungen parallel):

| Wann | Agent(en) |
|---|---|
| Bevor du etwas als fertig, deployt oder live meldest | `reality-checker` |
| Vor jedem Commit oder PR mit nicht-trivialem Code | `code-reviewer` |
| Code an Auth, API-Routen, Datenbank-Rechten, Webhooks, Zahlungen, Lizenzen | zusätzlich `appsec-engineer` |
| Nach Deploy-/Server-Arbeit, neuen Integrationen, Keys im Chat oder Code | `secrets-hygiene` |
| EA-/Signal-Texte, Lot- und Risiko-Berechnungen, MQL-Code | `ea-risk-reviewer` |
| Öffentliche Texte mit Rendite-/Leistungsaussagen, Rechtstexte, heikle Schreiben an Mitarbeitende/Kunden | `legal-compliance-checker` |
| Rechnungen, Buchungen, Lexoffice, Rechnungsfunktionen | `bookkeeper` |

Auf Wunsch oder wenn es klar passt: `seo-specialist`, `aeo-foundations`, `ai-citation-strategist` (Websites), `brand-guardian` (Markentexte), `executive-summary` (Entscheidungsvorlagen).

Keine Pflicht bei reinen Fragen, Recherche, Tippfehlern und Einzeilern. Ergebnisse der Agenten nicht ungeprüft übernehmen: Kernaussagen kurz gegen Code oder Quelle prüfen. Kritische Befunde vor dem Abschluss beheben oder dem Nutzer ausdrücklich nennen.
<!-- fach-agenten:end -->
