import "server-only";
import { cache } from "react";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { isPrivateOnly } from "@/lib/features";
import { imprintSettings, type ImprintSettings } from "@/lib/imprint";
import { aiReplyDisclosure, type AiReplyDisclosure } from "@/lib/ai-replies";
import { avvAcceptedAtLeast, RETENTION_MIN_AVV } from "@/lib/legal";
import { publicBookingAvailable } from "@/server/portal-booking";
import { defaultServiceDescription, homeVisitAreas, safeUrl, websiteOpeningHours, websitePublished, websiteSettings, type OpeningHour } from "@/lib/website";

/**
 * Öffentliche Praxis-Website (/p/[slug]): liefert NUR öffentliche Geschäftsangaben der Praxis
 * (Name, Adresse, Kontakt, Leistungen, Zeiten) – nie Patientendaten. null, wenn nicht veröffentlicht.
 */
export type PublicSite = {
  slug: string;
  name: string;
  legalName: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  vatId: string | null;
  websiteUrl: string | null;
  claim: string;
  about: string;
  practitioner: { name: string; qualification?: string } | null;
  openingDate: string | null;
  imprint: string;
  /** strukturierte Impressums-Pflichtangaben (Einstellungen → Praxis, src/lib/imprint.ts) */
  imprintInfo: ImprintSettings;
  privacy: string;
  /** KI-Antwortvorschläge eingeschaltet: Anbieter und Land für die Datenschutzhinweise (src/lib/ai-replies.ts), sonst null */
  aiReplies: AiReplyDisclosure | null;
  /**
   * Automatische Löschung unbestätigter Online-Anfragen nach 6 Monaten aktiv (AVV ab RETENTION_MIN_AVV akzeptiert –
   * dieselbe Prüfung wie der Löschlauf, src/server/online-request-retention.ts); sonst kein fester Zeitraum im Text
   */
  onlineRequestRetention: boolean;
  showPrices: boolean;
  onlineBooking: boolean;
  /** Praxis nur für Privatpatient:innen & Selbstzahler (src/lib/features.ts): Badge, keine Kassen-Hinweise */
  privateOnly: boolean;
  openingHours: OpeningHour[];
  homeVisitAreas: string[];
  services: { name: string; description: string; durationMin: number; priceCents: number | null; category: string }[];
};

const PUBLIC_CATEGORIES = ["treatment", "brace", "cosmetic", "travel"];

export const loadPublicSite = cache(async (slug: string): Promise<PublicSite | null> => {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!o || o.deletionRequestedAt || !websitePublished(o)) return null;
  const settings = o.settings ?? {};
  const w = websiteSettings(settings);
  const svc = await withOrg(o.id, (tx) =>
    tx
      .select({ code: services.code, name: services.name, priceCents: services.priceCents, durationMin: services.durationMin, category: services.category })
      .from(services)
      .where(and(eq(services.organizationId, o.id), eq(services.active, true), inArray(services.category, PUBLIC_CATEGORIES)))
      .orderBy(asc(services.name)),
  );
  const practitioner = settings.practitioner as { name?: unknown; qualification?: unknown } | undefined;
  return {
    slug: o.slug,
    name: o.name,
    legalName: o.legalName,
    street: o.street,
    zip: o.zip,
    city: o.city,
    phone: o.phone,
    email: o.email,
    vatId: o.vatId,
    websiteUrl: safeUrl(settings.websiteUrl),
    claim: w.claim,
    about: w.about,
    practitioner: typeof practitioner?.name === "string" && practitioner.name ? { name: practitioner.name, qualification: typeof practitioner.qualification === "string" ? practitioner.qualification : undefined } : null,
    openingDate: typeof settings.openingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(settings.openingDate) ? settings.openingDate : null,
    imprint: w.imprint,
    imprintInfo: imprintSettings(settings),
    privacy: w.privacy,
    aiReplies: aiReplyDisclosure(settings),
    onlineRequestRetention: avvAcceptedAtLeast(settings, RETENTION_MIN_AVV),
    showPrices: w.showPrices,
    // „Termin online buchen“ nur, wenn /buchen wirklich erreichbar ist (eingeschaltet, Impressum vollständig, kein
    // Nur-Lesen/Löschantrag) – gleiche Regel wie Buchungsseite und Datenschutzblock (src/server/portal-booking.ts)
    onlineBooking: await publicBookingAvailable(o.id),
    privateOnly: isPrivateOnly(o),
    openingHours: websiteOpeningHours(settings),
    homeVisitAreas: homeVisitAreas(settings),
    services: svc.map((s) => ({
      name: s.name,
      description: w.serviceDescriptions[s.code] ?? defaultServiceDescription(s.name),
      durationMin: s.durationMin,
      // 0 € = Platzhalter → „auf Anfrage“
      priceCents: s.priceCents > 0 ? s.priceCents : null,
      category: s.category,
    })),
  };
});

/** Angaben für Impressum und Datenschutzhinweise einer Praxis (Website /p und Online-Buchung /buchen) */
export type PracticeLegal = Pick<PublicSite, "slug" | "name" | "legalName" | "street" | "zip" | "city" | "phone" | "email" | "vatId" | "imprint" | "imprintInfo" | "privacy" | "aiReplies" | "onlineRequestRetention" | "onlineBooking"> & {
  /** Praxis-Website veröffentlicht → Impressum/Datenschutz unter /p/<slug>/…, sonst Ersatzseiten unter /buchen/<slug>/… */
  websitePublished: boolean;
};

/**
 * Impressum/Datenschutz der Praxis ohne Website-Pflicht (für die Online-Buchung): dieselben Stammdaten und Texte wie
 * die Praxis-Website (Einstellungen → Praxis bzw. Website). null bei unbekannter Praxis oder beantragter Löschung.
 */
export const loadPracticeLegal = cache(async (slug: string): Promise<PracticeLegal | null> => {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!o || o.deletionRequestedAt) return null;
  const w = websiteSettings(o.settings ?? {});
  return {
    slug: o.slug,
    name: o.name,
    legalName: o.legalName,
    street: o.street,
    zip: o.zip,
    city: o.city,
    phone: o.phone,
    email: o.email,
    vatId: o.vatId,
    imprint: w.imprint,
    imprintInfo: imprintSettings(o.settings ?? {}),
    privacy: w.privacy,
    aiReplies: aiReplyDisclosure(o.settings ?? {}),
    onlineRequestRetention: avvAcceptedAtLeast(o.settings ?? {}, RETENTION_MIN_AVV),
    onlineBooking: await publicBookingAvailable(o.id),
    websitePublished: websitePublished(o),
  };
});

/** Links zu Impressum und Datenschutzhinweisen der Praxis (Website, sonst Ersatzseiten der Online-Buchung) */
export function practiceLegalLinks(p: Pick<PracticeLegal, "slug" | "websitePublished">) {
  const base = p.websitePublished ? `/p/${p.slug}` : `/buchen/${p.slug}`;
  return { imprint: `${base}/impressum`, privacy: `${base}/datenschutz` };
}
