"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { LIMITS, parseAreas, type OpeningHour, type WebsiteSettings } from "@/lib/website";

type State = { error?: string; ok?: string } | undefined;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const schema = z.object({
  claim: z.string().trim().max(LIMITS.claim, `Claim: höchstens ${LIMITS.claim} Zeichen.`),
  about: z.string().trim().max(LIMITS.about, `„Über uns“: höchstens ${LIMITS.about} Zeichen.`),
  imprint: z.string().trim().max(LIMITS.imprint),
  privacy: z.string().trim().max(LIMITS.privacy),
  areas: z.string().max(3000),
});

/** Einstellungen → Website: Inhalte der öffentlichen Praxis-Website (/p/[slug]) speichern. */
export async function saveWebsiteAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const s = (k: string) => String(form.get(k) ?? "");
  const parsed = schema.safeParse({ claim: s("claim"), about: s("about"), imprint: s("imprint"), privacy: s("privacy"), areas: s("areas") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;

  const hours: OpeningHour[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const from = s(`from${wd}`).trim();
    const to = s(`to${wd}`).trim();
    if (!from && !to) continue;
    if (!time.safeParse(from).success || !time.safeParse(to).success || from >= to) return { error: `Praxiszeiten: bitte für Tag ${wd} „von“ und „bis“ (HH:MM, von vor bis) angeben oder beide leer lassen.` };
    hours.push({ weekday: wd, from, to });
  }

  // Kurzbeschreibungen nur für vorhandene Leistungen der eigenen Praxis
  const codes = await withOrg(auth.organization.id, (tx) => tx.select({ code: services.code }).from(services).where(eq(services.organizationId, auth.organization.id)));
  const serviceDescriptions: Record<string, string> = {};
  for (const { code } of codes) {
    const v = s(`desc_${code}`).trim().slice(0, LIMITS.serviceDescription);
    if (v) serviceDescriptions[code] = v;
  }

  const website: WebsiteSettings = {
    enabled: form.get("enabled") === "on",
    claim: d.claim,
    about: d.about,
    showPrices: form.get("showPrices") === "on",
    imprint: d.imprint,
    privacy: d.privacy,
    serviceDescriptions,
  };
  const patch = { website, openingHours: hours, homeVisitAreas: parseAreas(d.areas) };
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.website", meta: { enabled: website.enabled, showPrices: website.showPrices } });
  revalidatePath("/einstellungen/website");
  return { ok: website.enabled ? "Gespeichert – die Website ist eingeschaltet." : "Gespeichert." };
}
