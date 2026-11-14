import "server-only";
import { cache } from "react";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { isPrivateOnly } from "@/lib/features";
import { imprintSettings, type ImprintSettings } from "@/lib/imprint";
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
  taxNumber: string | null;
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
  const booking = settings.onlineBooking as { enabled?: boolean } | undefined;
  return {
    slug: o.slug,
    name: o.name,
    legalName: o.legalName,
    street: o.street,
    zip: o.zip,
    city: o.city,
    phone: o.phone,
    email: o.email,
    taxNumber: o.taxNumber,
    vatId: o.vatId,
    websiteUrl: safeUrl(settings.websiteUrl),
    claim: w.claim,
    about: w.about,
    practitioner: typeof practitioner?.name === "string" && practitioner.name ? { name: practitioner.name, qualification: typeof practitioner.qualification === "string" ? practitioner.qualification : undefined } : null,
    openingDate: typeof settings.openingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(settings.openingDate) ? settings.openingDate : null,
    imprint: w.imprint,
    imprintInfo: imprintSettings(settings),
    privacy: w.privacy,
    showPrices: w.showPrices,
    onlineBooking: booking?.enabled !== false,
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
export type PracticeLegal = Pick<PublicSite, "slug" | "name" | "legalName" | "street" | "zip" | "city" | "phone" | "email" | "taxNumber" | "vatId" | "imprint" | "imprintInfo" | "privacy"> & {
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
    taxNumber: o.taxNumber,
    vatId: o.vatId,
    imprint: w.imprint,
    imprintInfo: imprintSettings(o.settings ?? {}),
    privacy: w.privacy,
    websitePublished: websitePublished(o),
  };
});

/** Links zu Impressum und Datenschutzhinweisen der Praxis (Website, sonst Ersatzseiten der Online-Buchung) */
export function practiceLegalLinks(p: Pick<PracticeLegal, "slug" | "websitePublished">) {
  const base = p.websitePublished ? `/p/${p.slug}` : `/buchen/${p.slug}`;
  return { imprint: `${base}/impressum`, privacy: `${base}/datenschutz` };
}
