"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { validateWeek, weekToList } from "@/lib/opening-hours";
import { LIMITS, parseAreas, type OpeningHour, type WebsiteSettings } from "@/lib/website";

type State = { error?: string; ok?: string } | undefined;

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

  // Website-Zeiten: Standard = Praxis-Öffnungszeiten; abweichende Zeiten nur ohne Haken „wie Praxis-Öffnungszeiten“
  const customHours = form.get("samePracticeHours") !== "on";
  let hours: OpeningHour[] | undefined;
  if (customHours) {
    let raw: unknown;
    try {
      raw = JSON.parse(s("websiteHours"));
    } catch {
      return { error: "Website-Zeiten konnten nicht gelesen werden." };
    }
    const v = validateWeek(raw);
    if (v.error !== undefined) return { error: `Website-Zeiten – ${v.error}` };
    hours = weekToList(v.week);
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
    customHours,
  };
  // ohne eigene Zeiten bleiben früher gepflegte Website-Zeiten gespeichert (Schalter zurück → wieder da)
  const patch = { website, ...(hours ? { openingHours: hours } : {}), homeVisitAreas: parseAreas(d.areas) };
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.website", meta: { enabled: website.enabled, showPrices: website.showPrices, customHours } });
  revalidatePath("/einstellungen/website");
  return { ok: website.enabled ? "Gespeichert – die Website ist eingeschaltet." : "Gespeichert." };
}
