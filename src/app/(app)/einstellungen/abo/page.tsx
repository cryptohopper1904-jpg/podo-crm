import { Badge, Button, Card, CardTitle, Table } from "@/components/ui";
import { getBillingPort } from "@/integrations/stripe";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { dateDe, money, moneyShort } from "@/lib/format";
import { WEBSITE_ADDON_CENTS, WEBSITE_ADDON_PLANS } from "@/lib/website";
import { withOrg } from "@/db";
import { EXTRA_SEAT_CENTS, FEATURE_LABELS, FEATURES, FREE_MAX_PATIENTS, freeSwitchProblem, GRACE_DAYS, grossLabel, isPaidPlan, PAID_PLANS, PLANS, PRICES_NOTE, READONLY_REASON_LABELS, SEAT_FREE_NOTE, seatLimit, VOICE_ADDON_MINUTES, VOICE_ADDON_PLANS } from "@/lib/plans";
import { activeTeamMembers, loadOrgBilling, usedSeats } from "@/server/billing";
import { countedPatients } from "@/server/patient-limit";
import { PROMO_FREE_RETURN_NOTE, PROMO_FREE_RETURN_NOTE_BEFORE, promoRedemptionProblem, trialDaysLabel } from "@/lib/promo-codes";
import { redemptionForOrganization } from "@/server/promo-codes";
import { FreePlanForm } from "./free-form";
import { PromoForm } from "./promo-form";
import { openPortalAction } from "./actions";
import { CheckoutForm } from "./checkout-form";
import { CancelSubscriptionForm, ResumeSubscriptionForm } from "./cancel-form";
import Link from "next/link";
import { CANCEL_FAILED_MESSAGE, cancelStateFromSettings, hasRunningSubscription } from "@/lib/subscription-cancel";
import { readonlyDeletionNotice } from "@/server/readonly-expiry";

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
  const [used, team] = await Promise.all([usedSeats(auth.organization.id), activeTeamMembers(auth.organization.id)]);
  const limit = seatLimit(auth.billing);
  const port = getBillingPort();
  const plan = PLANS[(org?.plan as keyof typeof PLANS) ?? "trial"] ?? PLANS.trial;
  const a = auth.access;
  const patientCount = await withOrg(auth.organization.id, (tx) => countedPatients(tx, auth.organization.id));
  const freeProblem = org ? freeSwitchProblem(org, patientCount) : null;
  const redemption = await redemptionForOrganization(auth.organization.id);
  const promoProblem = org ? promoRedemptionProblem(org) : "Praxis nicht gefunden.";
  const running = !!org && hasRunningSubscription(org);
  const cancel = cancelStateFromSettings(org?.settings);
  const periodEndLabel = org?.currentPeriodEnd ? dateDe(org.currentPeriodEnd) : "Ende des Abrechnungszeitraums";
  const expiry = a.mode === "readonly" ? await readonlyDeletionNotice(auth.organization.id) : null;
  const freeWarning =
    [
      a.trialDaysLeft !== undefined ? `Die Testphase (noch ${a.trialDaysLeft} ${a.trialDaysLeft === 1 ? "Tag" : "Tage"}) endet damit sofort – Patientenportal, KI-Telefon und Website werden abgeschaltet.` : null,
      team > 1 ? `${team - 1} weitere Teammitglied(er) werden deaktiviert – auch der Empfang, denn der kostenlose Tarif ist auf 1 Person begrenzt (die Steuerberatung bleibt).` : null,
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted">Tarif</p>
            <p className="font-display text-2xl font-semibold">{plan.label}</p>
            <p className="mt-1"><Badge tone={a.mode === "readonly" ? "accent" : org?.subscriptionStatus === "active" ? "primary" : "warn"}>{STATUS_LABELS[org?.subscriptionStatus ?? "none"] ?? org?.subscriptionStatus}</Badge></p>
          </div>
          <div>
            <p className="text-sm text-muted">Plätze belegt / gebucht</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{used} / {Number.isFinite(limit) ? limit : "∞"}</p>
            <p className="text-[13px] text-muted">{org?.plan === "free" ? "Kostenloser Tarif: 1 Person, die Steuerberatung zählt nicht." : `Inhaber:in, Podolog:innen und Azubis. ${SEAT_FREE_NOTE}`}</p>
          </div>
          <div>
            {a.trialDaysLeft !== undefined ? (
              <><p className="text-sm text-muted">Testphase</p><p className="font-display text-2xl font-semibold">noch {a.trialDaysLeft} {a.trialDaysLeft === 1 ? "Tag" : "Tage"}</p><p className="text-[13px] text-muted">bis {dateDe(org?.trialEndsAt ?? null)}</p></>
            ) : org?.currentPeriodEnd ? (
              <><p className="text-sm text-muted">Bezahlt bis</p><p className="font-display text-2xl font-semibold">{dateDe(org.currentPeriodEnd)}</p></>
            ) : null}
          </div>
        </div>
        {a.mode === "readonly" ? (
          <p className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">
            {READONLY_REASON_LABELS[a.reason]} Die Praxis ist im Nur-Lesen-Modus: Alle Daten bleiben lesbar und exportierbar, Änderungen sind bis zur Wahl eines Tarifs gesperrt.
            {expiry ? <> Ohne Tarif wird die Praxis ab dem <strong>{dateDe(expiry.deletionAt)}</strong> gelöscht (höchstens 12 Monate nach Vertragsende) – erstelle vorher den Export unter Daten & Kündigung.</> : null}
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

      {running ? (
        <Card>
          <CardTitle>Abo kündigen</CardTitle>
          {cancel.cancelAtPeriodEnd ? (
            <>
              <p className="mb-3 text-[15px]" data-testid="abo-gekuendigt">
                Dein Abo ist zum <strong>{periodEndLabel}</strong> gekündigt{cancel.reason === "deletion_request" ? " (mit deinem Löschantrag)" : ""}. Bis dahin
                nutzt du PodoHero wie gewohnt; danach wird nichts mehr abgebucht. {GRACE_DAYS} Tage nach dem Ende wechselt die Praxis in den
                Nur-Lesen-Modus. Nach dem Ende bleibt die Praxis bis zu 12 Monate lesbar und alle Daten exportierbar; danach wird sie gelöscht.
              </p>
              <ResumeSubscriptionForm
                disabledReason={
                  org?.deletionRequestedAt ? (
                    "Es läuft ein Löschantrag. Nimmst du ihn unter Daten & Kündigung zurück, wird auch die damit verbundene Kündigung zurückgenommen."
                  ) : null
                }
              />
            </>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                Kündigung jederzeit zum Ende des laufenden Abrechnungszeitraums (derzeit {periodEndLabel}); danach wird nichts mehr abgebucht. Deine
                Daten bleiben erhalten: {GRACE_DAYS} Tage nach dem Ende wechselt die Praxis in den Nur-Lesen-Modus. Nach dem Ende bleibt die Praxis
                bis zu 12 Monate lesbar und alle Daten exportierbar; danach wird sie gelöscht. Bis zum Ende kannst du die Kündigung hier zurücknehmen. Soll die Praxis auch gelöscht werden, nutze{" "}
                <Link href="/einstellungen/daten" className="font-semibold text-primary underline">Daten & Kündigung</Link>.
              </p>
              {cancel.error && org?.deletionRequestedAt ? (
                <p role="alert" className="mb-3 rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">{CANCEL_FAILED_MESSAGE}</p>
              ) : null}
              <CancelSubscriptionForm periodEnd={periodEndLabel} />
            </>
          )}
        </Card>
      ) : null}

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
            0 € ohne Zeitlimit für kleine Praxen: bis zu {FREE_MAX_PATIENTS} Patient:innen (archivierte zählen mit), 1 Person, Termine, Doku, Rechnungen und Kasse. Ohne Patientenportal, KI-Telefon und Praxis-Website. Aktuell: {patientCount} Patient:innen.
          </p>
          <FreePlanForm disabledReason={freeProblem} warning={freeWarning} />
        </Card>
      ) : null}

      {redemption ? (
        <Card>
          <CardTitle>Aktionscode</CardTitle>
          <p className="text-sm">
            Code <span className="font-mono font-semibold">{redemption.code}</span> eingelöst am {dateDe(redemption.redeemedAt)} ({trialDaysLabel(redemption.trialDays)}).
            Die Testphase läuft bis <strong>{dateDe(redemption.trialEndsAfter)}</strong>. Je Praxis ist ein Aktionscode möglich.
          </p>
          {redemption.previousPlan === "free" && org?.subscriptionStatus === "trialing" ? (
            <p className="mt-2 text-sm text-muted">{PROMO_FREE_RETURN_NOTE}</p>
          ) : null}
        </Card>
      ) : !promoProblem ? (
        <Card>
          <CardTitle>Aktionscode einlösen</CardTitle>
          <p className="mb-3 text-sm text-muted">
            Mit einem Aktionscode verlängert sich die Testphase (z. B. auf 90 Tage ab heute; eine längere laufende Testphase wird nie verkürzt).
            Auch nach Ablauf der Testphase möglich – je Praxis einmal, nicht bei laufendem Abo.
          </p>
          {org?.plan === "free" ? <p className="mb-3 rounded-xl bg-info-soft px-4 py-3 text-sm text-info-soft-text">{PROMO_FREE_RETURN_NOTE_BEFORE}</p> : null}
          <PromoForm />
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

      <Table label="Tarife im Vergleich">
        <thead>
          <tr><th>Tarif</th><th>Preis pro Monat</th><th>Plätze</th>{FEATURES.map((f) => <th key={f}>{FEATURE_LABELS[f]}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            <td><p className="font-semibold">{PLANS.free.label}</p><p className="text-sm text-muted">{PLANS.free.description}</p></td>
            <td className="tabular-nums">{moneyShort(0)}</td>
            <td>1, max. 1</td>
            {FEATURES.map((f) => <td key={f}>–</td>)}
          </tr>
          {PAID_PLANS.map((p) => (
            <tr key={p}>
              <td><p className="font-semibold">{PLANS[p].label}</p><p className="text-sm text-muted">{PLANS[p].description}</p></td>
              <td className="tabular-nums">
                {money(PLANS[p].priceCents)} netto
                <span className="block text-[13px] text-muted">{grossLabel(PLANS[p].priceCents)}</span>
                {PLANS[p].maxSeats !== 1 ? <span className="block text-[13px] text-muted">+ {money(EXTRA_SEAT_CENTS)} netto ({grossLabel(EXTRA_SEAT_CENTS)}) je weiterem Platz</span> : null}
              </td>
              <td>{PLANS[p].includedSeats} inkl.{PLANS[p].maxSeats ? `, max. ${PLANS[p].maxSeats}` : ", unbegrenzt"}<span className="block text-[13px] text-muted">Empfang kostenlos</span></td>
              {FEATURES.map((f) => <td key={f}>{PLANS[p].features.includes(f) ? (f === "voice_agent" ? `✓ (${PLANS[p].voiceMinutesIncluded} Min./Monat)` : "✓") : f === "voice_agent" && VOICE_ADDON_PLANS.includes(p) ? `Zusatzmodul (${VOICE_ADDON_MINUTES} Min./Monat)` : f === "website" && WEBSITE_ADDON_PLANS.includes(p) ? `Zusatzmodul (${money(WEBSITE_ADDON_CENTS)} netto/Monat, ${grossLabel(WEBSITE_ADDON_CENTS)}, vorläufig)` : "–"}</td>)}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-sm font-semibold text-warn-soft-text"><Badge tone="warn">Preise vorläufig</Badge> <span className="ml-2 font-normal text-muted">{PRICES_NOTE}</span></p>
      <p className="text-sm text-muted">
        Ein Platz ist für eine Person mit Behandlungsrolle (Inhaber:in, Podolog:in, Azubi). {SEAT_FREE_NOTE} Kündigung jederzeit zum Ende des Abrechnungszeitraums. Nach dem Ende des Abos und {GRACE_DAYS} Tagen Kulanz wechselt die Praxis in den Nur-Lesen-Modus; alle Daten bleiben lesbar und exportierbar (Einstellungen → Daten & Kündigung, Patientenexport in der Akte). Nach dem Ende bleibt die Praxis bis zu 12 Monate lesbar und alle Daten exportierbar; danach wird sie gelöscht (Ankündigung mindestens 30 Tage vorher) – oder früher auf deinen Löschantrag hin.
      </p>
    </div>
  );
}
