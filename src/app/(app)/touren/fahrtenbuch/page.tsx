import Link from "next/link";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Stat, Table } from "@/components/ui";
import { audit } from "@/lib/audit";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe } from "@/lib/format";
import { kmDe, minDe } from "@/lib/routing/geo";
import { distanceSourceLabel, TRIP_LOG_DISCLAIMER } from "@/lib/routing/trip-log";
import { canReadTripLog, listTripsMonth } from "@/server/trips";

export const metadata = { title: "Fahrtenbuch" };

const monthLabel = (m: string) => new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`));

export default async function TripLogPage(props: PageProps<"/touren/fahrtenbuch">) {
  const auth = await requireAuth();
  if (!canReadTripLog(auth)) denyAccess(auth, "appointments.read");
  const sp = await props.searchParams;
  const month = typeof sp.monat === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.monat) ? sp.monat : berlinDateIso().slice(0, 7);
  const { trips, totals } = await listTripsMonth(auth, month);
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "trips.log.view", meta: { month, count: trips.length } });
  const exportHref = (format: "csv" | "pdf") => `/api/fahrtenbuch/export?monat=${month}&format=${format}`;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Fahrtenbuch"
        subtitle={auth.can("appointments.read") ? <Link href="/touren" className="hover:text-primary">← Touren</Link> : "Hilfe für Hausbesuchsfahrten"}
        actions={
          <>
            <a href={exportHref("csv")} className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-2">CSV</a>
            <a href={exportHref("pdf")} className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-2">PDF</a>
          </>
        }
      />
      <Card className="mb-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Monat"><Input type="month" name="monat" defaultValue={month} /></Field>
          <Button type="submit" variant="secondary">Anzeigen</Button>
        </form>
      </Card>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label={`Fahrten ${monthLabel(month)}`} value={totals.count} tone="primary" />
        <Stat label="Kilometer" value={kmDe(totals.distanceM)} sub={totals.estimated ? `${totals.estimated} Fahrt(en) geschätzt` : undefined} tone="info" />
        <Stat label="Fahrzeit" value={minDe(totals.durationSec)} tone="neutral" />
      </div>
      {trips.length === 0 ? (
        <Empty title="Keine Fahrten in diesem Monat">Fahrten entstehen über „Ich fahre los“ bei einem Hausbesuch.</Empty>
      ) : (
        <Table>
          <thead>
            <tr><th>Datum</th><th>Start</th><th>Ziel</th><th>Zweck</th><th className="text-right">km</th><th>Kennzeichen</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.id} className={t.voided ? "text-muted line-through" : ""}>
                <td className="tabular-nums">{dateDe(t.tripDate)}</td>
                <td>{t.fromLabel}</td>
                <td>{t.toLabel}</td>
                <td>{t.purpose}</td>
                <td className="text-right tabular-nums">{kmDe(t.distanceM)}</td>
                <td>{t.plate ?? "–"}</td>
                <td className="no-underline">
                  {t.voided ? <Badge>storniert</Badge> : t.corrected ? <Badge tone="info">korrigiert</Badge> : <Badge tone={t.distanceSource === "estimate" ? "warn" : "neutral"}>{distanceSourceLabel(t.distanceSource)}</Badge>}
                </td>
                <td><Link href={`/touren/fahrtenbuch/${t.id}`} className="font-semibold text-primary">Details</Link></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="mt-6 text-xs text-muted">{TRIP_LOG_DISCLAIMER} Ziele sind pseudonymisiert (Kundennummer), Änderungen nur als nachvollziehbare Korrektur.</p>
    </div>
  );
}
