import { Card, LinkButton } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { READONLY_REASON_LABELS } from "@/lib/plans";

export const metadata = { title: "Nur lesen" };

/** Ziel, wenn eine schreibende Aktion im Nur-Lesen- oder Support-Modus abgelehnt wurde. */
export default async function ReadOnlyPage({ searchParams }: PageProps<"/nur-lesen">) {
  const auth = await requireAuth();
  const { grund } = await searchParams;
  const support = grund === "support" || !!auth.support;
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <h1 className="font-display text-2xl font-semibold">Diese Aktion ist gerade nicht möglich</h1>
        {support ? (
          <p className="mt-3 text-muted">
            Du bist im <strong>Support-Zugriff</strong>. Er ist nur zum Ansehen freigegeben – Änderungen in der Praxis sind ausgeschlossen.
          </p>
        ) : (
          <>
            <p className="mt-3 text-muted">
              {auth.access.reason ? READONLY_REASON_LABELS[auth.access.reason] : "Die Praxis ist im Nur-Lesen-Modus."} Änderungen sind deshalb
              gesperrt.
            </p>
            <p className="mt-3 text-muted">
              <strong>Alle Daten bleiben vollständig lesbar und exportierbar</strong> – Patientenakten, Dokumentation, Rechnungen und
              Patientenexporte (§ 630g BGB, Art. 15/20 DSGVO). Nichts wird gelöscht.
            </p>
          </>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {!support && auth.role === "owner" ? <LinkButton href="/einstellungen/abo">Abo & Tarif öffnen</LinkButton> : null}
          {!support && auth.role !== "owner" ? <p className="text-sm text-muted">Bitte die Praxisinhaberin bzw. den Praxisinhaber informieren.</p> : null}
          <LinkButton href="/heute" variant="secondary">Zur Startseite</LinkButton>
        </div>
      </Card>
    </div>
  );
}
