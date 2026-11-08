import { notFound } from "next/navigation";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, organizations, services } from "@/db/schema";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { freeSlotsPublic } from "@/server/booking";
import { BookingForm } from "./booking-form";

export const metadata = { title: "Termin buchen", robots: { index: true, follow: false } };

/**
 * Öffentliche Online-Buchung (Selbstzahler-Leistungen). GKV-Verordnungen werden wie bei pododesk
 * weiterhin in der Praxis terminiert. Es werden keine Namen oder Gesundheitsdaten anderer Patienten angezeigt.
 */
export default async function BookingPage(props: PageProps<"/buchen/[slug]">) {
  const { slug } = await props.params;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  const settings = (org?.settings ?? {}) as { onlineBooking?: { enabled?: boolean; serviceCodes?: string[] }; opening?: { from: string; to: string } };
  if (!org || settings.onlineBooking?.enabled === false) notFound();
  const svc = await withOrg(org.id, (tx) =>
    tx
      .select({ id: services.id, code: services.code, name: services.name, priceCents: services.priceCents, durationMin: services.durationMin })
      .from(services)
      .where(and(eq(services.organizationId, org.id), eq(services.active, true), inArray(services.category, ["treatment", "cosmetic", "brace"])))
      .orderBy(asc(services.name)),
  );
  const allowed = settings.onlineBooking?.serviceCodes;
  const offered = allowed?.length ? svc.filter((s) => allowed.includes(s.code)) : svc;
  // Nächste 14 Tage: freie Slots für 30/40/60 Minuten
  const days: { date: string; slots: Record<number, string[]> }[] = [];
  const start = berlinDateIso();
  const from = berlinToUtc(start, "00:00");
  const to = new Date(from.getTime() + 15 * 86400_000);
  const busy = await withOrg(org.id, (tx) =>
    tx.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status }).from(appointments).where(and(eq(appointments.organizationId, org.id), gte(appointments.startsAt, from), lt(appointments.startsAt, to))),
  );
  const durations = [...new Set(offered.map((s) => s.durationMin))];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(from.getTime() + i * 86400_000 + 12 * 3600_000).toISOString().slice(0, 10);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || holidayOn(d, org.state as StateCode)) continue;
    const slots: Record<number, string[]> = {};
    for (const dur of durations) slots[dur] = freeSlotsPublic(busy.filter((b) => b.status !== "cancelled"), d, dur, settings.opening);
    days.push({ date: d, slots });
  }
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
