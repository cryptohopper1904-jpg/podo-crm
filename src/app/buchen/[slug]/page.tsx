import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { publicBookingOptions } from "@/server/portal-booking";
import { BookingForm } from "./booking-form";

export const metadata = { title: "Termin buchen", robots: { index: true, follow: false } };

/**
 * Öffentliche Online-Buchung (Selbstzahler-Leistungen). GKV-Verordnungen werden wie bei pododesk
 * weiterhin in der Praxis terminiert. Es werden keine Namen oder Gesundheitsdaten anderer Patienten angezeigt.
 */
export default async function BookingPage(props: PageProps<"/buchen/[slug]">) {
  const { slug } = await props.params;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) notFound();
  // Gleiche Verfügbarkeit wie Portal und Telefon (Arbeitszeiten, Abwesenheiten, Feiertage) – Gesamt-Review M1
  const options = await publicBookingOptions(org.id);
  if (!options) notFound();
  const offered = options.services;
  const days = options.days;
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      <h1 className="font-display text-3xl font-semibold">Termin buchen</h1>
      <p className="mt-1 text-muted">{org.name}{org.city ? ` · ${org.city}` : ""}</p>
      <p className="mt-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Hier buchst du Selbstzahler-Leistungen. Für Behandlungen mit ärztlicher Verordnung (Kasse) ruf uns bitte an{org.phone ? ` unter ${org.phone}` : ""}.
      </p>
      <BookingForm slug={slug} services={offered} days={days} />
    </main>
  );
}
