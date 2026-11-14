import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { publicBookingAvailable } from "@/server/portal-booking";
import { loadPracticeLegal } from "@/server/website";

/**
 * Impressum/Datenschutz zur Online-Buchung für Praxen ohne veröffentlichte Website: nur solange /buchen/<slug>
 * erreichbar ist (sonst dieselbe 404 wie bei unbekannter Praxis). Mit Website gelten die Seiten unter /p/<slug>/….
 */
export const loadBookingLegal = cache(async (slug: string) => {
  const legal = await loadPracticeLegal(slug);
  if (!legal) return null;
  const [o] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  if (!o || !(await publicBookingAvailable(o.id))) return null;
  return legal;
});
