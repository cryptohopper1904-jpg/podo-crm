Fach-Agenten (Kopie aus claude-config)
======================================

12 Subagenten für Claude Code. Wann sie Pflicht sind und wie sie im Chat
gekennzeichnet werden, steht im Abschnitt "Fach-Agenten" der CLAUDE.md
dieses Repos.

Prüfen, nichts ändern:  reality-checker, code-reviewer, appsec-engineer,
                        secrets-hygiene, legal-compliance-checker,
                        ea-risk-reviewer, bookkeeper, executive-summary
Dürfen Texte ändern:    seo-specialist, aeo-foundations,
                        ai-citation-strategist, brand-guardian

Quelle: Repo claude-config, Ordner agents/. Änderungen dort machen und in
die Repos kopieren, damit alle Fassungen gleich bleiben.

Herkunft: 11 Agenten basieren auf agency-agents
(github.com/msitarzewski/agency-agents, MIT-Lizenz, siehe
LICENSE-agency-agents.txt) mit deutschem Kopfblock; ea-risk-reviewer ist ein
eigener Agent.
