import { desc, eq } from "drizzle-orm";
import { Star } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, PageHeader, Textarea } from "@/components/ui";
import { db, withOrg } from "@/db";
import { organizations, reviews } from "@/db/schema";
import { aiReplySettings } from "@/lib/ai-replies";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { loadConnection } from "@/server/integrations";
import { publishReviewReplyAction, suggestReviewReplyAction, syncReviewsAction } from "./actions";

export const metadata = { title: "Bewertungen" };

function Stars({ n }: { n: number | null }) {
  if (n === null) return <span className="text-muted">–</span>;
  return (
    <span className="inline-flex" aria-label={`${n} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={16} aria-hidden className={i <= n ? "fill-current text-warn-soft-text" : "text-border-strong"} />
      ))}
    </span>
  );
}

export default async function ReviewsPage() {
  const auth = await requireAuth("messages.read");
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) => tx.select().from(reviews).where(eq(reviews.organizationId, org)).orderBy(desc(reviews.createdAtExternal)).limit(200));
  const conn = await loadConnection(org, "google_business");
  const placeId = typeof conn?.config?.placeId === "string" ? (conn.config.placeId as string) : null;
  const reviewLink = placeId ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}` : null;
  const rated = rows.filter((r) => r.rating !== null);
  const avg = rated.length ? rated.reduce((a, r) => a + (r.rating ?? 0), 0) / rated.length : null;
  const canWrite = auth.can("messages.write");
  // KI-Vorschlag nur bei eingeschalteten KI-Antwortvorschlägen (Einstellungen → Praxis)
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const aiEnabled = aiReplySettings(o?.settings).enabled;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Bewertungen"
        subtitle={avg !== null ? `Ø ${avg.toFixed(1).replace(".", ",")} Sterne aus ${rated.length} Bewertungen` : "Google Unternehmensprofil"}
        actions={canWrite ? <ActionForm action={syncReviewsAction} submit="Bewertungen abrufen" className="flex items-center gap-2">{null}</ActionForm> : null}
      />
      <p className="mb-4 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
        Schweigepflicht: Antworten sind öffentlich. Nie bestätigen, dass jemand Patient:in ist, und keine Behandlungen, Termine oder Gesundheitsangaben erwähnen –
        auch nicht, wenn die bewertende Person sie selbst nennt. Antworten mit solchen Begriffen werden blockiert.
      </p>

      <Card className="mb-6">
        <CardTitle>Bewertungslink &amp; QR-Code</CardTitle>
        {reviewLink ? (
          <>
            <p className="mb-2 text-sm">Diesen Link nach dem Termin teilen (nur mit Einwilligung „Bewertungsanfrage“):</p>
            <code className="block break-all rounded-xl bg-surface-2 p-3 text-xs">{reviewLink}</code>
          </>
        ) : (
          <p className="text-sm text-muted">Place-ID unter Einstellungen → Schnittstellen → Google Unternehmensprofil eintragen, dann erscheint hier der Bewertungslink.</p>
        )}
        <p className="mt-2 text-sm text-muted">
          Einen QR-Code für den Empfangstresen erhalten Sie im Google Unternehmensprofil unter „Bewertungen erhalten“. Keine Gegenleistungen für
          Bewertungen anbieten (UWG, Google-Richtlinien) und nicht gezielt nur zufriedene Patient:innen fragen.
        </p>
      </Card>

      {rows.length === 0 ? (
        <Empty title="Noch keine Bewertungen">„Bewertungen abrufen“ lädt die Bewertungen aus dem Google Unternehmensprofil.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((r) => (
            <Card key={r.id}>
              <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                <Stars n={r.rating} />
                <span className="font-semibold">{r.author ?? "Anonym"}</span>
                <span className="text-muted">{dateDe(r.createdAtExternal)}</span>
                {r.reply ? <Badge tone="primary">beantwortet</Badge> : <Badge tone="warn">offen</Badge>}
              </div>
              <p className="whitespace-pre-wrap">{r.text ?? <span className="text-muted">(ohne Text)</span>}</p>
              {r.reply ? (
                <p className="mt-3 whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-sm"><strong>Ihre Antwort:</strong> {r.reply}</p>
              ) : canWrite ? (
                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
                  {aiEnabled ? (
                    <ActionForm action={suggestReviewReplyAction} submit="KI-Antwortvorschlag" className="flex flex-col gap-2">
                      <input type="hidden" name="id" value={r.id} />
                    </ActionForm>
                  ) : null}
                  <ActionForm action={publishReviewReplyAction} submit="Antwort veröffentlichen">
                    <input type="hidden" name="id" value={r.id} />
                    <Field label="Antwort" hint="Ohne Behandlungs- oder Gesundheitsbezug.">
                      <Textarea name="reply" rows={4} defaultValue={r.aiSuggestion ?? ""} key={r.aiSuggestion ?? "leer"} />
                    </Field>
                  </ActionForm>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
