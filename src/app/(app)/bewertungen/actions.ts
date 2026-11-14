"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { organizations, reviews } from "@/db/schema";
import { describeError } from "@/integrations/test-connection";
import { aiReplySettings } from "@/lib/ai-replies";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { neutralReviewReply, reviewReplyProblems } from "@/lib/review-guard";
import { adapterFor, logSync } from "@/server/integrations";

export type ReviewState = { error?: string; ok?: string } | undefined;

export async function syncReviewsAction(): Promise<ReviewState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  try {
    const port = await adapterFor(org, "google_business");
    const { reviews: list } = await port.listReviews();
    let created = 0;
    await withOrg(org, async (tx) => {
      const existing = await tx.select({ id: reviews.id, externalId: reviews.externalId }).from(reviews).where(eq(reviews.organizationId, org));
      const byExt = new Map(existing.map((e) => [e.externalId, e.id]));
      for (const r of list) {
        const values = { author: r.author, rating: r.rating, text: r.text, reply: r.reply, createdAtExternal: r.createdAt ? new Date(r.createdAt) : null };
        const id = byExt.get(r.externalId);
        if (id) await tx.update(reviews).set(values).where(and(eq(reviews.organizationId, org), eq(reviews.id, id)));
        else {
          await tx.insert(reviews).values({ organizationId: org, provider: "google", externalId: r.externalId, ...values });
          created++;
        }
      }
    });
    await logSync(org, "google_business", { direction: "in", ok: true, message: `${list.length} Bewertungen abgerufen${port.isMock ? " (Testmodus)" : ""}` });
    revalidatePath("/bewertungen");
    return { ok: `${list.length} Bewertungen abgerufen, ${created} neu.` };
  } catch (e) {
    await logSync(org, "google_business", { direction: "in", ok: false, message: describeError(e) });
    return { error: "Abruf fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
}

export async function suggestReviewReplyAction(_: ReviewState, form: FormData): Promise<ReviewState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Bewertung nicht gefunden." };
  // gleicher Schalter wie im Posteingang (Einstellungen → Praxis → KI-Antwortvorschläge; Standard aus, AppSec L-1)
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  if (!aiReplySettings(o?.settings).enabled) {
    return { error: "KI-Antwortvorschläge sind ausgeschaltet. Einschalten kann sie die Inhaberin bzw. der Inhaber unter Einstellungen → Praxis." };
  }
  const [r] = await withOrg(org, (tx) => tx.select().from(reviews).where(and(eq(reviews.organizationId, org), eq(reviews.id, id.data))));
  if (!r) return { error: "Bewertung nicht gefunden." };
  let suggestion: string;
  let note = "Vorschlag erstellt – bitte prüfen.";
  try {
    const llm = await adapterFor(org, "llm");
    suggestion = await llm.suggestReply(r.text ?? `Bewertung mit ${r.rating ?? "?"} Sternen ohne Text`, {
      practiceName: auth.organization.name,
      tone: "friendly",
      knownNames: r.author ? [r.author] : [],
      facts: [
        "Dies ist eine ÖFFENTLICHE Antwort auf eine Google-Bewertung.",
        "Schweigepflicht: niemals bestätigen, dass die Person Patient:in ist; keine Behandlungen, Termine, Befunde, Erkrankungen oder Körperteile erwähnen.",
        "Nur allgemein danken bzw. bei Kritik Gesprächsbereitschaft anbieten. Höchstens 3 Sätze. Keinen Namen nennen.",
      ],
    });
  } catch (e) {
    await logSync(org, "llm", { direction: "out", ok: false, message: `Bewertungsantwort: ${describeError(e)}` });
    return { error: "KI-Vorschlag fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
  const problems = reviewReplyProblems(suggestion);
  if (problems.length) {
    suggestion = neutralReviewReply(r.rating, auth.organization.name);
    note = `KI-Vorschlag verworfen (Schweigepflicht: ${problems.join(", ")}). Neutrale Vorlage eingesetzt.`;
  }
  await withOrg(org, (tx) => tx.update(reviews).set({ aiSuggestion: suggestion }).where(and(eq(reviews.organizationId, org), eq(reviews.id, r.id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "ai.review_suggestion", entity: "review", entityId: r.id, meta: { rejected: problems } });
  revalidatePath("/bewertungen");
  return { ok: note };
}

export async function publishReviewReplyAction(_: ReviewState, form: FormData): Promise<ReviewState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  const text = z.string().trim().min(5, "Antwort ist zu kurz.").max(4000).safeParse(form.get("reply"));
  if (!id.success) return { error: "Bewertung nicht gefunden." };
  if (!text.success) return { error: text.error.issues[0]?.message };
  // Schutz gilt auch für selbst geschriebene Antworten
  const problems = reviewReplyProblems(text.data);
  if (problems.length) {
    return { error: `Nicht veröffentlicht – mögliche Verletzung der Schweigepflicht (${problems.join(", ")}). Bitte ohne Behandlungs- oder Gesundheitsbezug formulieren.` };
  }
  const [r] = await withOrg(org, (tx) => tx.select().from(reviews).where(and(eq(reviews.organizationId, org), eq(reviews.id, id.data))));
  if (!r) return { error: "Bewertung nicht gefunden." };
  try {
    const port = await adapterFor(org, "google_business");
    await port.replyToReview(r.externalId, text.data);
    await withOrg(org, (tx) => tx.update(reviews).set({ reply: text.data, repliedAt: new Date() }).where(and(eq(reviews.organizationId, org), eq(reviews.id, r.id))));
    await logSync(org, "google_business", { direction: "out", ok: true, message: port.isMock ? "Antwort (Testmodus)" : "Antwort veröffentlicht", entity: "review", entityId: r.id });
    await audit({ organizationId: org, userId: auth.user.id, action: "review.reply", entity: "review", entityId: r.id, meta: { mock: port.isMock } });
    revalidatePath("/bewertungen");
    return { ok: port.isMock ? "Testmodus: Antwort gespeichert, nicht bei Google veröffentlicht." : "Antwort veröffentlicht." };
  } catch (e) {
    await logSync(org, "google_business", { direction: "out", ok: false, message: describeError(e), entity: "review", entityId: r.id });
    return { error: "Veröffentlichen fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
}
