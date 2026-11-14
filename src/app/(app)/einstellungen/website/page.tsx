import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Checkbox, Field, Input, Textarea } from "@/components/ui";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { money } from "@/lib/format";
import { emptyWeek, storedPracticeHours, weekFromList } from "@/lib/opening-hours";
import { defaultServiceDescription, homeVisitAreas, LIMITS, openingHours, WEBSITE_ADDON_CENTS, websiteEntitlement, websiteSettings } from "@/lib/website";
import { saveWebsiteAction } from "./actions";
import { WebsiteHours } from "./website-hours";

export const metadata = { title: "Website" };

export default async function WebsiteSettingsPage() {
  const auth = await requireAuth("settings.manage");
  const [o] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  const settings = o.settings ?? {};
  const w = websiteSettings(settings);
  const ent = websiteEntitlement(auth.billing, settings);
  const practice = storedPracticeHours(settings);
  const svc = await withOrg(o.id, (tx) =>
    tx.select({ code: services.code, name: services.name, active: services.active, category: services.category }).from(services).where(eq(services.organizationId, o.id)).orderBy(services.name),
  );
  const shown = svc.filter((s) => s.active && s.category !== "product");
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const host = (() => {
    try {
      return base ? new URL(base).host : "<Server-Adresse>";
    } catch {
      return "<Server-Adresse>";
    }
  })();
  const url = `${base}/p/${o.slug}`;
  const live = w.enabled && ent.entitled;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
          Praxis-Website
          {live ? <Badge tone="primary">online</Badge> : w.enabled ? <Badge tone="warn">eingeschaltet, aber offline</Badge> : <Badge>aus</Badge>}
          {ent.source === "addon" ? <Badge tone="info">Zusatzmodul</Badge> : null}
        </h2>
        <p className="text-sm text-muted">
          Eine einfache, moderne Website für eure Praxis – erzeugt aus den Praxisdaten: Leistungen, Praxiszeiten, Hausbesuchsgebiet, Kontakt und
          „Termin online buchen“. Ohne Cookies, ohne Tracking, ohne eingebettete Karten. Hell/Dunkel und für Smartphones optimiert.
        </p>
        <p className="mt-3 text-sm">
          Adresse: <a href={url} target="_blank" rel="noreferrer" className="break-all font-semibold text-primary">{url}</a>
        </p>
        {!ent.entitled && ent.reason ? <p className="mt-3 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text">{ent.reason}{ent.addonAvailable ? " Bitte beim Support buchen." : " Bitte unter Abo & Tarif upgraden."}</p> : null}
        <p className="mt-3 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
          <strong>Eigene Domain</strong> (z. B. www.eure-praxis.de): beim Domain-Anbieter einen CNAME-Eintrag auf <code className="font-mono">{host}</code> anlegen
          und uns die Domain mitteilen – wir schalten sie für eure Website frei. (Nur Information, die Einrichtung erfolgt durch den Support.)
        </p>
        <p className="mt-3 text-[13px] text-muted">
          Zusatzmodul im Tarif Starter: {money(WEBSITE_ADDON_CENTS)}/Monat (vorläufig); in Praxis und Plus enthalten. Ein Praxisfoto kann in einer späteren Version ergänzt werden.
        </p>
      </Card>

      <Card>
        <ActionForm action={saveWebsiteAction} stickyActions>
          <Checkbox name="enabled" defaultChecked={w.enabled} label="Website veröffentlichen" />
          <Field label="Claim (Untertitel unter dem Praxisnamen)" hint={`höchstens ${LIMITS.claim} Zeichen, z. B. „Podologie in Hohen Neuendorf – in der Praxis und bei Ihnen zu Hause“`}>
            <Input name="claim" defaultValue={w.claim} maxLength={LIMITS.claim} />
          </Field>
          <Field label="Über uns" hint="Wer behandelt, Qualifikation, Schwerpunkte – keine Patientendaten.">
            <Textarea name="about" defaultValue={w.about} maxLength={LIMITS.about} rows={5} />
          </Field>
          <Checkbox name="showPrices" defaultChecked={w.showPrices} label="Preise anzeigen (Leistungen mit 0 € erscheinen als „auf Anfrage“)" />

          <WebsiteHours custom={w.customHours} practice={practice} own={w.customHours ? weekFromList(openingHours(settings)) : (practice ?? emptyWeek())} />

          <Field label="Hausbesuche in" hint="Orte durch Komma oder Zeilenumbruch trennen">
            <Textarea name="areas" defaultValue={homeVisitAreas(settings).join(", ")} rows={2} />
          </Field>

          {shown.length ? (
            <fieldset className="min-w-0 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold">Kurzbeschreibungen der Leistungen</legend>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {shown.map((s) => (
                  <Field key={s.code} label={s.name}>
                    <Textarea name={`desc_${s.code}`} defaultValue={w.serviceDescriptions[s.code] ?? ""} placeholder={defaultServiceDescription(s.name) || "Kurz beschreiben …"} maxLength={LIMITS.serviceDescription} rows={2} />
                  </Field>
                ))}
              </div>
              <p className="mt-2 text-[13px] text-muted">Leer gelassen: der grau angezeigte Vorschlag wird verwendet. Leistungen selbst unter Einstellungen → Leistungen.</p>
            </fieldset>
          ) : null}

          <Field label="Impressum – weitere Pflichtangaben" hint="Name, Adresse und Kontakt kommen aus den Praxisdaten. Bitte ergänzen: vertretungsberechtigte Person, Berufsbezeichnung (z. B. Podologin, staatlich anerkannt, verliehen in Deutschland), zuständige Behörde, berufsrechtliche Regelungen (PodG).">
            <Textarea name="imprint" defaultValue={w.imprint} maxLength={LIMITS.imprint} rows={5} />
          </Field>
          <Field label="Datenschutzerklärung" hint="Von der Praxis auszufüllen (Verantwortliche, Zwecke, Rechte). Ein Hinweis, dass die Seite keine Cookies/Tracking nutzt, wird automatisch ergänzt.">
            <Textarea name="privacy" defaultValue={w.privacy} maxLength={LIMITS.privacy} rows={6} />
          </Field>
          {w.enabled && (!w.imprint || !w.privacy) ? <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">Bitte Impressum und Datenschutzerklärung ausfüllen – beide sind für eine öffentliche Website Pflicht.</p> : null}
        </ActionForm>
      </Card>
    </div>
  );
}
