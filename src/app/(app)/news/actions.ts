"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { refreshNews } from "@/server/news";

export type NewsState = { error?: string; ok?: string } | undefined;

/** Manueller Abruf („Jetzt aktualisieren“); läuft zusätzlich automatisch über /api/cron/news. */
export async function refreshNewsAction(): Promise<NewsState> {
  const auth = await requireAuth();
  const r = await refreshNews(auth.organization.id);
  if (r.loaded === 0) return { error: `Keine Meldungen geladen. ${r.errors.join("; ")}` };
  await audit({
    organizationId: auth.organization.id,
    userId: auth.user.id,
    action: "news.refresh",
    meta: { loaded: r.loaded, relevant: r.relevant, added: r.added, removed: r.removed, errors: r.errors.length },
  });
  revalidatePath("/news");
  return { ok: `${r.added} neue Podologie-Meldungen.${r.removed ? ` ${r.removed} nicht relevante entfernt.` : ""}${r.errors.length ? ` Hinweise: ${r.errors.join("; ")}` : ""}` };
}
