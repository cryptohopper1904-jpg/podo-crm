import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ClipboardCheck, ClipboardList, Download, FileText, MapPin, MessageCircle, Pencil, Phone, Stethoscope } from "lucide-react";
import { Badge, Card, CardTitle, Empty, LinkButton, Stat } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { ageYears, dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/patient-status";
import { CONSENT_LABELS } from "@/lib/consents";
import { currentConsents, getPatient } from "@/server/patients";
import { recordConsentAction } from "../actions";

export const metadata = { title: "Kundenakte" };

const INSURANCE: Record<string, string> = { gkv: "GKV", pkv: "Privat", self: "Selbstzahler", beihilfe: "Beihilfe" };
const APPT_STATUS: Record<string, string> = { planned: "geplant", confirmed: "bestätigt", done: "erledigt", cancelled: "abgesagt", no_show: "nicht erschienen" };
const INVOICE_STATUS: Record<string, string> = { draft: "Entwurf", issued: "offen", partially_paid: "teilbezahlt", paid: "bezahlt", cancelled: "storniert" };

export default async function PatientPage(props: PageProps<"/kunden/[id]">) {
  const { id } = await props.params;
  const auth = await requireAuth("patients.read");
  const data = await getPatient(auth, id);
  if (!data) notFound();
  const { patient: p } = data;
  const age = ageYears(p.birthDate);
  const consents = currentConsents(data.consents);
  const address = [p.street, [p.zip, p.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const phone = p.phoneMobile ?? p.phoneLandline;
  const waNumber = p.phoneMobile?.replace(/\D/g, "").replace(/^0/, "49");
  const waAllowed = consents.get("whatsapp")?.granted;

  type Item = { at: Date; kind: string; title: string; detail?: string; href?: string };
  const timeline: Item[] = [
    ...data.appointments.map((a) => ({ at: a.startsAt, kind: "Termin", title: `${a.title ?? "Termin"} · ${APPT_STATUS[a.status]}`, detail: a.notes ?? undefined })),
    ...data.records.map((r) => ({ at: r.treatedAt, kind: "Doku", title: r.servicesText ?? "Behandlung dokumentiert", detail: r.findings ?? undefined, href: `/kunden/${p.id}/doku/${r.id}` })),
    ...data.invoices.map((i) => ({ at: i.createdAt, kind: "Rechnung", title: `${i.number ?? "Entwurf"} · ${money(i.totalCents)} · ${INVOICE_STATUS[i.status]}`, href: `/rechnungen/${i.id}` })),
    ...data.consents.map((c) => ({ at: c.recordedAt, kind: "Einwilligung", title: `${CONSENT_LABELS[c.type] ?? c.type}: ${c.granted ? "erteilt" : "widerrufen"}` })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">
            Kunde #{p.number} · {INSURANCE[p.insuranceType]}{p.insurerName ? ` (${p.insurerName})` : ""}{age !== null ? ` · ${age} Jahre` : ""}
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{fullName(p)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="primary">{STATUS_LABEL[data.status]}</Badge>
            {p.homeVisit ? <Badge tone="info">Hausbesuch</Badge> : null}
            <RiskBadges flags={p.riskFlags} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {auth.can("medical.write") ? (
            <LinkButton href={`/kunden/${p.id}/doku/neu`}><Stethoscope size={18} aria-hidden /> Behandlung dokumentieren</LinkButton>
          ) : null}
          <LinkButton href={`/kunden/${p.id}/anamnese`} variant="secondary"><ClipboardCheck size={18} aria-hidden /> Anamnese</LinkButton>
          <LinkButton href={`/kunden/${p.id}/verordnungen`} variant="secondary"><ClipboardList size={18} aria-hidden /> Verordnungen</LinkButton>
          {auth.can("appointments.write") ? (
            <LinkButton href={`/kalender/neu?patient=${p.id}`} variant="secondary"><CalendarPlus size={18} aria-hidden /> Termin</LinkButton>
          ) : null}
          {auth.can("invoices.write") ? (
            <LinkButton href={`/rechnungen/neu?patient=${p.id}`} variant="secondary"><FileText size={18} aria-hidden /> Rechnung</LinkButton>
          ) : null}
          {auth.can("patients.write") ? (
            <LinkButton href={`/kunden/${p.id}/bearbeiten`} variant="ghost" aria-label="Bearbeiten"><Pencil size={18} aria-hidden /></LinkButton>
          ) : null}
        </div>
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Behandlungen" value={data.records.length} sub={`${data.appointments.length} Termine gesamt`} tone="primary" />
        <Stat label="Umsatz (bezahlt)" value={money(data.revenueCents)} tone="info" />
        <Stat label="Offener Betrag" value={money(data.openCents)} tone={data.openCents > 0 ? "accent" : "neutral"} />
        <Stat label="Fotos" value={data.media.filter((m) => m.kind === "photo").length} sub="verschlüsselt gespeichert" tone="warn" />
      </div>

      <div className="flex flex-wrap gap-6">
        <div className="flex min-w-0 flex-[2_1_480px] flex-col gap-6">
          <Card>
            <CardTitle>Zeitleiste</CardTitle>
            {timeline.length === 0 ? (
              <Empty title="Noch keine Einträge" />
            ) : (
              <ol className="flex flex-col">
                {timeline.slice(0, 60).map((t, i) => (
                  <li key={i} className="flex gap-4 border-t border-border py-3 first:border-t-0">
                    <span className="w-28 shrink-0 text-sm tabular-nums text-muted">{dateTimeDe(t.at)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <Badge tone={t.kind === "Doku" ? "primary" : t.kind === "Rechnung" ? "info" : t.kind === "Einwilligung" ? "warn" : "neutral"} className="mr-2">{t.kind}</Badge>
                        {t.href ? <Link href={t.href} className="font-semibold hover:text-primary">{t.title}</Link> : <span className="font-semibold">{t.title}</span>}
                      </p>
                      {t.detail ? <p className="mt-1 line-clamp-2 text-sm text-muted">{t.detail}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {auth.can("medical.read") ? (
            <Card>
              <CardTitle action={<Link href={`/kunden/${p.id}/fotos`} className="text-sm font-semibold text-primary">Alle Fotos & Vergleich</Link>}>Fotos</CardTitle>
              {data.media.filter((m) => m.kind === "photo").length === 0 ? (
                <Empty title="Noch keine Fotos">Fotos werden direkt in der Behandlung mit dem iPad/iPhone aufgenommen.</Empty>
              ) : (
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {data.media
                    .filter((m) => m.kind === "photo")
                    .slice(0, 12)
                    .map((m) => (
                      <figure key={m.id} className="overflow-hidden rounded-xl bg-surface-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/media/${m.id}`} alt={`Foto ${m.footSide === "left" ? "links" : m.footSide === "right" ? "rechts" : ""} ${m.toe ? `D${m.toe}` : ""}`} className="aspect-square w-full object-cover" loading="lazy" />
                        <figcaption className="px-2 py-1 text-[11px] text-muted">{dateDe(m.takenAt)}{m.toe ? ` · ${m.footSide === "left" ? "li" : "re"} D${m.toe}` : ""}</figcaption>
                      </figure>
                    ))}
                </div>
              )}
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-6">
          <Card>
            <CardTitle>Kontakt</CardTitle>
            <dl className="flex flex-col gap-3 text-[15px]">
              {address ? (
                <div className="flex items-start gap-2">
                  <MapPin size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <div>
                    <dd>{address}</dd>
                    {/* Nur die Adresse geht an Google Maps, kein Name, keine Gesundheitsdaten */}
                    <a className="text-sm font-semibold text-primary" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}>Route öffnen</a>
                  </div>
                </div>
              ) : null}
              {phone ? (
                <a href={`tel:${phone}`} className="flex items-center gap-2 font-semibold hover:text-primary"><Phone size={18} aria-hidden /> {phone}</a>
              ) : null}
              {waNumber && waAllowed ? (
                <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 font-semibold hover:text-primary"><MessageCircle size={18} aria-hidden /> WhatsApp</a>
              ) : null}
              {p.email ? <a href={`mailto:${p.email}`} className="break-all font-semibold hover:text-primary">{p.email}</a> : null}
              <div className="text-sm text-muted">
                Geburtsdatum: {dateDe(p.birthDate)}<br />
                Hausarzt: {p.gpName ?? "–"}<br />
                Bevorzugt: {p.preferredChannel === "none" ? "–" : p.preferredChannel}
              </div>
              {p.notes ? <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">{p.notes}</p> : null}
            </dl>
          </Card>

          <Card>
            <CardTitle>Einwilligungen</CardTitle>
            <ul className="flex flex-col gap-2">
              {Object.entries(CONSENT_LABELS).map(([type, label]) => {
                const c = consents.get(type);
                return (
                  <li key={type} className="flex items-center gap-3 text-sm">
                    <span className="flex-1">{label}</span>
                    {c ? <Badge tone={c.granted ? "primary" : "neutral"}>{c.granted ? `ja · ${dateDe(c.recordedAt)}` : "nein"}</Badge> : <Badge>offen</Badge>}
                    {auth.can("patients.write") ? (
                      <form action={recordConsentAction}>
                        <input type="hidden" name="patientId" value={p.id} />
                        <input type="hidden" name="type" value={type} />
                        <input type="hidden" name="granted" value={c?.granted ? "0" : "1"} />
                        <button className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-surface-2" type="submit">
                          {c?.granted ? "widerrufen" : "erteilt"}
                        </button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">Die Behandlungsdoku selbst braucht keine Einwilligung (Art. 9 Abs. 2 lit. h DSGVO). Jede Änderung wird mit Zeitpunkt protokolliert.</p>
          </Card>

          <Card>
            <CardTitle>Datenschutz</CardTitle>
            <div className="flex flex-col gap-2">
              <LinkButton variant="secondary" href={`/api/patients/${p.id}/export`}><Download size={18} aria-hidden /> Auskunft (Art. 15) als JSON</LinkButton>
              <LinkButton variant="secondary" href={`/kunden/${p.id}/akte-drucken`}>Akte drucken / PDF</LinkButton>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
