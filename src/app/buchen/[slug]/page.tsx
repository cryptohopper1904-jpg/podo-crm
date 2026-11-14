import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { isPrivateOnly } from "@/lib/features";
import { publicBookingOptions } from "@/server/portal-booking";
import { BookingForm } from "./booking-form";

/** Praxis + buchbare Termine (einmal je Anfrage, für Metadaten und Seite) */
const loadBooking = cache(async (slug: string) => {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return null;
  // Gleiche Verfügbarkeit wie Portal und Telefon (Arbeitszeiten, Abwesenheiten, Feiertage) – Gesamt-Review M1
  const options = await publicBookingOptions(org.id);
  return options ? { org, options } : null;
});

/** Unbekannte Praxis/keine Online-Buchung: notFound() schon hier, sonst stünde „Termin buchen“ im Titel der 404-Seite */
export async function generateMetadata(props: PageProps<"/buchen/[slug]">): Promise<Metadata> {
  if (!(await loadBooking((await props.params).slug))) notFound();
  return { title: "Termin buchen", robots: { index: true, follow: false } };
}

/**
 * Öffentliche Online-Buchung (Selbstzahler-Leistungen). GKV-Verordnungen werden wie bei pododesk
 * weiterhin in der Praxis terminiert. Es werden keine Namen oder Gesundheitsdaten anderer Patienten angezeigt.
 */
export default async function BookingPage(props: PageProps<"/buchen/[slug]">) {
  const { slug } = await props.params;
  const data = await loadBooking(slug);
  if (!data) notFound();
  const { org, options } = data;
  const offered = options.services;
  const days = options.days;
  return (
    <main className="mx-auto min-h-screen max-w-3xl py-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <header className="mb-8 flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      <h1 className="font-display text-3xl font-semibold">Termin buchen</h1>
      <p className="mt-1 text-muted">{org.name}{org.city ? ` · ${org.city}` : ""}</p>
      <p className="mt-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        {isPrivateOnly(org)
          ? <>Wir behandeln Privatpatient:innen und Selbstzahler. Bei Fragen rufen Sie uns gern an{org.phone ? ` unter ${org.phone}` : ""}.</>
          : <>Hier buchen Sie Selbstzahler-Leistungen. Für Behandlungen mit ärztlicher Verordnung (Kasse) rufen Sie uns bitte an{org.phone ? ` unter ${org.phone}` : ""}.</>}
      </p>
      <BookingForm slug={slug} services={offered} days={days} />
    </main>
  );
}
