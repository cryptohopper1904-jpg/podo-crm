import { Badge, Button, Card, CardTitle, Table } from "@/components/ui";
import { getBillingPort } from "@/integrations/stripe";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { dateDe, money } from "@/lib/format";
import { WEBSITE_ADDON_CENTS, WEBSITE_ADDON_PLANS } from "@/lib/website";
import { withOrg } from "@/db";
import { EXTRA_SEAT_CENTS, FEATURE_LABELS, FEATURES, FREE_MAX_PATIENTS, freeSwitchProblem, isPaidPlan, PAID_PLANS, PLANS, PRICES_NOTE, READONLY_REASON_LABELS, seatLimit, VOICE_ADDON_MINUTES, VOICE_ADDON_PLANS } from "@/lib/plans";
import { loadOrgBilling, usedSeats } from "@/server/billing";
import { countedPatients } from "@/server/patient-limit";
import { FreePlanForm } from "./free-form";
import { openPortalAction } from "./actions";
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Abo & Tarif" };

const STATUS_LABELS: Record<string, string> = {
  trialing: "Testphase",
  active: "aktiv",
  past_due: "Zahlung offen",
  canceled: "beendet",
  paused: "pausiert",
  none: "kein Abo",
};

export default async function AboPage({ searchParams }: PageProps<"/einstellungen/abo">) {
  const auth = await requireAuth("settings.manage", { allowReadOnly: true });
  if (auth.role !== "owner" || auth.support) denyAccess(auth, "users.manage");
  const sp = await searchParams;
  const org = await loadOrgBilling(auth.organization.id);
  const used = await usedSeats(auth.organization.id);
  const limit = seatLimit(auth.billing);
  const port = getBillingPort();
  const plan = PLANS[(org?.plan as keyof typeof PLANS) ?? "trial"] ?? PLANS.trial;
  const a = auth.access;
  const patientCount = await withOrg(auth.organization.id, (tx) => countedPatients(tx, auth.organization.id));
  const freeProblem = org ? freeSwitchProblem(org, patientCount) : null;
  const freeWarning =
    [
      a.trialDaysLeft !== undefined ? `Die Testphase (noch ${a.trialDaysLeft} ${a.trialDaysLeft === 1 ? "Tag" : "Tage"}) endet damit sofort – Patientenportal, KI-Telefon und Website werden abgeschaltet.` : null,
      used > 1 ? `${used - 1} weitere Teammitglied(er) werden deaktiviert (die Steuerberatung bleibt).` : null,
    ]
      .filter(Boolean)
      .join(" ") || null;

  return (
    <div className="flex flex-col gap-6">
      {sp.checkout === "ok" ? <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">Danke! Sobald Stripe die Zahlung bestätigt, wird der Tarif hier angezeigt (meist nach wenigen Sekunden).</p> : null}
      {sp.checkout === "abgebrochen" ? <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">Der Bezahlvorgang wurde abgebrochen. Es wurde nichts gebucht.</p> : null}
      {sp.portal === "nicht-verfuegbar" ? <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">Rechnungen und Zahlungsart sind verfügbar, sobald ein Abo über Stripe abgeschlossen wurde.</p> : null}

      <Card>
        <CardTitle>Aktueller Tarif</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted">Tarif</p>
            <p className="font-display text-2xl font-semibold">{plan.label}</p>
            <p className="mt-1"><Badge tone={a.mode === "readonly" ? "accent" : org?.subscriptionStatus === "active" ? "primary" : "warn"}>{STATUS_LABELS[org?.subscriptionStatus ?? "none"] ?? org?.subscriptionStatus}</Badge></p>
          </div>
          <div>
            <p className="text-sm text-muted">Plätze belegt / gebucht</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{used} / {Number.isFinite(limit) ? limit : "∞"}</p>
            <p className="text-xs text-muted">Steuerberatung belegt keinen Platz.</p>
          </div>
          <div>
            {a.trialDaysLeft !== undefined ? (
              <><p className="text-sm text-muted">Testphase</p><p className="font-display text-2xl font-semibold">noch {a.trialDaysLeft} {a.trialDaysLeft === 1 ? "Tag" : "Tage"}</p><p className="text-xs text-muted">bis {dateDe(org?.trialEndsAt ?? null)}</p></>
            ) : org?.currentPeriodEnd ? (
              <><p className="text-sm text-muted">Bezahlt bis</p><p className="font-display text-2xl font-semibold">{dateDe(org.currentPeriodEnd)}</p></>
            ) : null}
          </div>
        </div>
        {a.mode === "readonly" ? (
          <p className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">
            {READONLY_REASON_LABELS[a.reason]} Die Praxis ist im Nur-Lesen-Modus: Alle Daten bleiben lesbar und exportierbar, Änderungen sind bis zur Wahl eines Tarifs gesperrt.
          </p>
        ) : a.graceEndsAt ? (
          <p className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">
            Die Zahlung ist offen. Ohne Zahlung wechselt die Praxis am {dateDe(a.graceEndsAt)} in den Nur-Lesen-Modus.
          </p>
        ) : null}
        <form action={openPortalAction} className="mt-4">
          <Button type="submit" variant="secondary" disabled={!org?.stripeCustomerId || port.isMock}>Rechnungen & Zahlungsart</Button>
        </form>
      </Card>

      {org?.plan === "free" ? (
        <Card>
          <CardTitle>Kostenloser Tarif</CardTitle>
          <p className="text-sm">
            Patient:innen: <span className="font-semibold tabular-nums">{patientCount} von {FREE_MAX_PATIENTS}</span> (archivierte zählen mit). Für mehr Patient:innen, ein Team, Patientenportal oder KI-Telefon unten einen Tarif wählen.
          </p>
        </Card>
      ) : org?.plan !== "internal" ? (
        <Card>
          <CardTitle>Kostenlos weiter nutzen</CardTitle>
          <p className="mb-3 text-sm text-muted">
            Dauerhaft 0 € für kleine Praxen: bis zu {FREE_MAX_PATIENTS} Patient:innen (archivierte zählen mit), 1 Person, Termine, Doku, Rechnungen und Kasse. Ohne Patientenportal, KI-Telefon und Praxis-Website. Aktuell: {patientCount} Patient:innen.
          </p>
          <FreePlanForm disabledReason={freeProblem} warning={freeWarning} />
        </Card>
      ) : null}

      <Card>
        <CardTitle>Tarif wählen</CardTitle>
        {port.isMock ? (
          <p className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-sm text-info-soft-text">
            Testmodus: Es ist kein Stripe-Zugang konfiguriert. „Tarif wählen“ stellt den Tarif sofort um, ohne Zahlung (nur in der Entwicklung).
          </p>
        ) : null}
        <CheckoutForm defaultPlan={isPaidPlan(org?.plan) ? org.plan : "praxis"} minSeats={used} mock={port.isMock} />
      </Card>

      <Table>
        <thead>
          <tr><th>Tarif</th><th>Preis (netto/Monat)</th><th>Plätze</th>{FEATURES.map((f) => <th key={f}>{FEATURE_LABELS[f]}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            <td><p className="font-semibold">{PLANS.free.label}</p><p className="text-sm text-muted">{PLANS.free.description}</p></td>
            <td className="tabular-nums">{money(0)}</td>
            <td>1, max. 1</td>
            {FEATURES.map((f) => <td key={f}>–</td>)}
          </tr>
          {PAID_PLANS.map((p) => (
            <tr key={p}>
              <td><p className="font-semibold">{PLANS[p].label}</p><p className="text-sm text-muted">{PLANS[p].description}</p></td>
              <td className="tabular-nums">{money(PLANS[p].priceCents)}{PLANS[p].maxSeats !== 1 ? <span className="block text-xs text-muted">+ {money(EXTRA_SEAT_CENTS)} je weiterem Platz</span> : null}</td>
              <td>{PLANS[p].includedSeats} inkl.{PLANS[p].maxSeats ? `, max. ${PLANS[p].maxSeats}` : ", unbegrenzt"}</td>
              {FEATURES.map((f) => <td key={f}>{PLANS[p].features.includes(f) ? (f === "voice_agent" ? `✓ (${PLANS[p].voiceMinutesIncluded} Min./Monat)` : "✓") : f === "voice_agent" && VOICE_ADDON_PLANS.includes(p) ? `Zusatzmodul (${VOICE_ADDON_MINUTES} Min./Monat)` : f === "website" && WEBSITE_ADDON_PLANS.includes(p) ? `Zusatzmodul (${money(WEBSITE_ADDON_CENTS)}/Monat, vorläufig)` : "–"}</td>)}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-sm font-semibold text-warn-soft-text"><Badge tone="warn">Preise vorläufig</Badge> <span className="ml-2 font-normal text-muted">{PRICES_NOTE}</span></p>
      <p className="text-sm text-muted">
        Kündigung jederzeit zum Ende des Abrechnungszeitraums. Nach dem Ende bleibt die Praxis lesbar und alle Daten exportierbar (Einstellungen → Import/Export, Patientenexport in der Akte).
      </p>
    </div>
  );
}
