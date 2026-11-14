import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Empty, Field, Input, Select, Table } from "@/components/ui";
import { dateDe, dateTimeDe } from "@/lib/format";
import { isPlanId, PLANS } from "@/lib/plans";
import { generatePromoCode, PROMO_DEFAULT_TRIAL_DAYS, PROMO_OWN_MIN_LENGTH, PROMO_GRANT_PLANS, promoLandingUrl, promoSignupUrl, trialDaysLabel } from "@/lib/promo-codes";
import { requirePlatformAdmin } from "@/server/platform";
import { listPromoCodes, listRedemptions } from "@/server/promo-codes";
import { listCampaigns } from "@/server/vertrieb-pipeline";
import { createPromoCodeAction, setPromoCodeActiveAction } from "../actions";
import { CopyButton } from "./copy-button";

export const metadata = { title: "Aktionscodes · Vertrieb" };

export default async function PromoCodesPage({ searchParams }: PageProps<"/plattform/vertrieb/aktionscodes">) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const preCampaign = typeof sp.kampagne === "string" && /^[0-9a-f-]{36}$/i.test(sp.kampagne) ? sp.kampagne : "";
  const [codes, reds, campaigns] = await Promise.all([listPromoCodes(), listRedemptions(), listCampaigns()]);
  const base = process.env.PUBLIC_URL;
  const suggested = generatePromoCode();

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted">
          Aktionscodes verlängern die Testphase neuer oder bestehender Praxen (z. B. 3 Monate statt 30 Tage) – nicht zu verwechseln mit den Gutscheinen der Praxen.
          Einlösen: bei der Registrierung über den Link oder später unter Einstellungen → Abo &amp; Tarif (je Praxis einmal, nicht bei laufendem Abo).
          Ungültige, abgelaufene oder aufgebrauchte Codes werden ohne Begründung abgelehnt.
        </p>
        {codes.length ? (
          <Table>
            <thead>
              <tr><th>Code</th><th>Testphase</th><th>Einlösungen</th><th>Gültig bis</th><th>Zuordnung</th><th>Links</th><th></th></tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id}>
                  <td>
                    <p className="font-mono font-semibold">{c.code}</p>
                    <p className="text-xs text-muted">{c.label}</p>
                    {c.usable ? <Badge tone="primary">einlösbar</Badge> : <Badge tone="neutral">{c.active ? "abgelaufen/aufgebraucht" : "deaktiviert"}</Badge>}
                  </td>
                  <td className="text-sm">{trialDaysLabel(c.trialDays)}<p className="text-xs text-muted">{c.grantPlan && isPlanId(c.grantPlan) ? `Umfang ${PLANS[c.grantPlan].label}` : "alle Funktionen"}</p></td>
                  <td className="tabular-nums">{c.redemptions}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}<p className="text-xs text-muted">{c.converted} zahlend</p></td>
                  <td className="text-sm">{c.validUntil ? dateDe(c.validUntil) : "unbegrenzt"}</td>
                  <td className="text-sm">{c.campaignName ? `Kampagne: ${c.campaignName}` : c.leadName ? `Praxis: ${c.leadName}` : "–"}</td>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      <CopyButton text={promoSignupUrl(base, c.code)} label="Registrierungslink" />
                      <CopyButton text={promoLandingUrl(base, c.code)} label="Aktionsseite" />
                    </div>
                  </td>
                  <td>
                    <form action={setPromoCodeActiveAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="active" value={c.active ? "nein" : "ja"} />
                      <Button type="submit" variant={c.active ? "danger" : "secondary"} className="h-9 px-3 text-sm">{c.active ? "Deaktivieren" : "Aktivieren"}</Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="Noch keine Aktionscodes">Rechts einen Code anlegen, z. B. 90 Tage für eine Kampagne.</Empty>
        )}

        <Card>
          <h2 className="font-display text-xl font-semibold">Einlösungen</h2>
          {reds.length ? (
            <div className="mt-3">
              <Table>
                <thead>
                  <tr><th>Praxis</th><th>Code</th><th>Eingelöst</th><th>Weg</th><th>Test bis</th><th>Zahlend</th></tr>
                </thead>
                <tbody>
                  {reds.map((r) => (
                    <tr key={r.id}>
                      <td><a href={`/plattform#praxis-${r.organizationId}`} className="font-semibold text-primary">{r.practiceName}</a></td>
                      <td className="font-mono text-sm">{codes.find((c) => c.id === r.codeId)?.code ?? "–"}</td>
                      <td className="text-sm">{dateTimeDe(r.redeemedAt)}</td>
                      <td className="text-sm">{r.via === "signup" ? "Registrierung" : "Abo-Seite"}</td>
                      <td className="text-sm">{dateDe(r.trialEndsAfter)}</td>
                      <td>{r.converted ? <Badge tone="primary">ja ({isPlanId(r.plan) ? PLANS[r.plan].label : r.plan})</Badge> : <Badge tone="neutral">nein</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Noch keine Einlösungen.</p>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 font-display text-xl font-semibold">Neuer Aktionscode</h2>
        <ActionForm action={createPromoCodeAction} submit="Code anlegen">
          <Field label="Code *" hint={`A–Z, 0–9, Bindestrich. Der zufällige Vorschlag ist schwer zu erraten. Selbst gewählte Codes: mindestens ${PROMO_OWN_MIN_LENGTH} Zeichen und Höchstzahl oder Ablaufdatum Pflicht.`}>
            <Input name="code" required maxLength={32} defaultValue={suggested} className="font-mono" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Bezeichnung (intern) *"><Input name="label" required maxLength={120} placeholder="z. B. Herbstkampagne Brandenburg" /></Field>
          <Field label="Testphase (Tage) *" hint="90 Tage ≈ 3 Monate. Eine längere laufende Testphase wird nie verkürzt.">
            <Input name="trialDays" type="number" min={1} max={365} required defaultValue={PROMO_DEFAULT_TRIAL_DAYS} />
          </Field>
          <Field label="Umfang während der Testphase">
            <Select name="grantPlan" defaultValue="">
              <option value="">Alle Funktionen (wie normale Testphase)</option>
              {PROMO_GRANT_PLANS.map((p) => <option key={p} value={p}>Tarif {PLANS[p].label}</option>)}
            </Select>
          </Field>
          <Field label="Höchstzahl Einlösungen" hint="leer = unbegrenzt"><Input name="maxRedemptions" type="number" min={1} max={100000} /></Field>
          <Field label="Gültig bis (einschließlich)" hint="leer = unbegrenzt"><Input name="validUntil" type="date" /></Field>
          <Field label="Kampagne" hint="Code wird in Mails dieser Kampagne für {{code}}/{{link}} verwendet.">
            <Select name="campaignId" defaultValue={preCampaign}>
              <option value="">keine</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (beendet)"}</option>)}
            </Select>
          </Field>
        </ActionForm>
        <p className="mt-4 text-xs text-muted">
          Code, Testtage und Umfang sind nach dem Anlegen fest (Nachweis gegenüber eingelösten Praxen). Zum Ändern: deaktivieren und neuen Code anlegen.
          Registrierungslink: {promoSignupUrl(base, "CODE")}
        </p>
      </Card>
    </div>
  );
}
