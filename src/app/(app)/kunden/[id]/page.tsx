import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ChevronDown, ClipboardCheck, ClipboardList, Download, FileText, MapPin, MessageCircle, Pencil, Phone, Receipt, Stethoscope } from "lucide-react";
import { Badge, Card, CardTitle, Empty, LinkButton, Stat, pageTitleBox, pageTitleCls, BackLink, cx } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { PortalLinkButton } from "@/components/portal-link-button";
import { requireAuth } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { ageYears, dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/patient-status";
import { CONSENT_LABELS } from "@/lib/consents";
import { currentConsents, getPatient } from "@/server/patients";
import { recordConsentAction } from "../actions";
import { WaitlistCard } from "./waitlist-card";
import { DeceasedCard } from "./deceased-card";
import { deceasedStatus } from "@/server/patient-deceased";
import { DECEASED_LABEL } from "@/lib/patient-deceased";
import { backHref } from "@/lib/back-link";

export const metadata = { title: "Patientenakte" };

const INSURANCE: Record<string, string> = { gkv: "GKV", pkv: "Privat", self: "Selbstzahler", beihilfe: "Beihilfe" };
const APPT_STATUS: Record<string, string> = { planned: "geplant", confirmed: "bestätigt", done: "erledigt", cancelled: "abgesagt", no_show: "nicht erschienen" };
const INVOICE_STATUS: Record<string, string> = { draft: "Entwurf", issued: "offen", partially_paid: "teilbezahlt", paid: "bezahlt", cancelled: "storniert" };

type Item = { at: Date; kind: string; title: string; detail?: string; href?: string };
/** Zeitleiste: die neuesten Einträge direkt, ältere aufklappbar (auf dem Handy sonst mehrere Bildschirmhöhen) */
const TIMELINE_FIRST = 8;
const TIMELINE_MAX = 60;
const KIND_TONE: Record<string, "primary" | "info" | "warn" | "neutral"> = { Doku: "primary", Rechnung: "info", Einwilligung: "warn" };

/** Eintrag der Zeitleiste: auf dem Handy Datum über dem Titel (statt fester Datumsspalte), Link als ganze Zeile. */
function TimelineItem({ t }: { t: Item }) {
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted sm:w-32 sm:shrink-0 sm:flex-col sm:items-start">
        <span className="tabular-nums">{dateTimeDe(t.at)}</span>
        <Badge tone={KIND_TONE[t.kind] ?? "neutral"}>{t.kind}</Badge>
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[15px] font-semibold wrap-break-word", t.href && "group-hover:text-primary")}>{t.title}</span>
        {t.detail ? <span className="mt-1 line-clamp-2 block text-sm text-muted">{t.detail}</span> : null}
      </span>
    </>
  );
  const row = "flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:gap-4";
  return (
    <li className="border-t border-border first:border-t-0">
      {t.href ? (
        <Link href={t.href} className={cx(row, "group -mx-2 rounded-lg px-2 hover:bg-surface-2")}>{body}</Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

export default async function PatientPage(props: PageProps<"/kunden/[id]">) {
  const { id } = await props.params;
  const { von } = await props.searchParams;
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
  const deceased = data.deceased;
  const deceasedCard = auth.can("patients.write") ? await deceasedStatus(auth, p.id) : null;

  const timeline: Item[] = [
    ...data.appointments.map((a) => ({ at: a.startsAt, kind: "Termin", title: `${a.title ?? "Termin"} · ${APPT_STATUS[a.status]}`, detail: a.notes ?? undefined, href: `/kalender/termin/${a.id}` })),
    ...data.records.map((r) => ({ at: r.treatedAt, kind: "Doku", title: r.servicesText ?? "Behandlung dokumentiert", detail: r.findings ?? undefined, href: `/kunden/${p.id}/doku/${r.id}` })),
    ...data.invoices.map((i) => ({ at: i.createdAt, kind: "Rechnung", title: `${i.number ?? "Entwurf"} · ${money(i.totalCents)} · ${INVOICE_STATUS[i.status]}`, href: `/rechnungen/${i.id}` })),
    ...data.consents.map((c) => ({ at: c.recordedAt, kind: "Einwilligung", title: `${CONSENT_LABELS[c.type] ?? c.type}: ${c.granted ? "erteilt" : "widerrufen"}` })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  /** Seltener genutzte Aktionen: am Desktop als Knöpfe, auf Handy/Tablet als Kacheln im Menü „Weitere Aktionen“ */
  const moreActions = (kind: "button" | "tile") => {
    const cls = kind === "tile" ? "h-auto min-h-14 whitespace-normal px-3 py-2 text-center text-sm leading-5" : undefined;
    return (
      <>
        {/* Anamnese: Bogen am iPad und Übergabe an Patient:innen sind auf der Anamnese-Seite */}
        <LinkButton href={`/kunden/${p.id}/anamnese`} variant="secondary" className={cls}><ClipboardCheck size={18} aria-hidden className="shrink-0" /> Anamnese</LinkButton>
        {auth.can("medical.read") && feature(auth.organization, "verordnungen") ? (
          <LinkButton href={`/kunden/${p.id}/verordnungen`} variant="secondary" className={cls}><ClipboardList size={18} aria-hidden className="shrink-0" /> Verordnungen</LinkButton>
        ) : null}
        {auth.can("invoices.write") ? (
          <>
            <LinkButton href={`/rechnungen/neu?patient=${p.id}`} variant="secondary" className={cls}><FileText size={18} aria-hidden className="shrink-0" /> Rechnung</LinkButton>
            <LinkButton href={`/rechnungen/neu?sammel=${p.id}`} variant="secondary" className={cls}><FileText size={18} aria-hidden className="shrink-0" /> Sammelrechnung</LinkButton>
            {!deceased && !p.archivedAt ? (
              <LinkButton href={`/rechnungen/anzahlung?patient=${p.id}`} variant="secondary" className={cls}><Receipt size={18} aria-hidden className="shrink-0" /> Anzahlung (Vorauszahlung)</LinkButton>
            ) : null}
          </>
        ) : null}
        {auth.can("patients.write") ? (
          kind === "tile" ? (
            <LinkButton href={`/kunden/${p.id}/bearbeiten`} variant="secondary" className={cls}><Pencil size={18} aria-hidden className="shrink-0" /> Bearbeiten</LinkButton>
          ) : (
            <LinkButton href={`/kunden/${p.id}/bearbeiten`} variant="ghost" aria-label="Bearbeiten" title="Bearbeiten"><Pencil size={18} aria-hidden /></LinkButton>
          )
        ) : null}
      </>
    );
  };

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className={pageTitleBox}>
          <BackLink href={backHref("/kunden", von)} label="Patienten" />
          <p className="text-sm text-muted">
            Patient #{p.number} · {INSURANCE[p.insuranceType]}{p.insurerName ? ` (${p.insurerName})` : ""}{age !== null ? ` · ${age} Jahre` : ""}
          </p>
          <h1 className={pageTitleCls}>{fullName(p)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {deceased ? (
              <Badge>{DECEASED_LABEL}{deceased.date ? ` am ${dateDe(deceased.date)}` : ""}</Badge>
            ) : (
              <Badge tone="primary">{STATUS_LABEL[data.status]}</Badge>
            )}
            {p.homeVisit ? <Badge tone="info">Hausbesuch</Badge> : null}
            <RiskBadges flags={p.riskFlags} />
          </div>
        </div>
        {/* Handy/Tablet: zwei Hauptaktionen + „Weitere Aktionen“ (Kachelraster); ab lg alle Knöpfe in einer Reihe */}
        <div className="flex w-full min-w-0 flex-col gap-2 lg:w-auto lg:max-w-full lg:flex-row lg:flex-wrap">
          <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
            {auth.can("medical.write") ? (
              <LinkButton href={`/kunden/${p.id}/doku/neu`} className="col-span-2"><Stethoscope size={18} aria-hidden /> Behandlung dokumentieren</LinkButton>
            ) : null}
            {auth.can("appointments.write") && !deceased ? (
              <LinkButton href={`/kalender/neu?patient=${p.id}`} variant="secondary" className="px-3"><CalendarPlus size={18} aria-hidden /> Termin</LinkButton>
            ) : null}
            {phone ? (
              <LinkButton href={`tel:${phone}`} variant="secondary" className="px-3 lg:hidden"><Phone size={18} aria-hidden /> Anrufen</LinkButton>
            ) : null}
          </div>
          <div className="hidden lg:flex lg:flex-wrap lg:gap-2">{moreActions("button")}</div>
          <details className="group lg:hidden">
            <summary className="flex h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              Weitere Aktionen <ChevronDown size={18} aria-hidden className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2">{moreActions("tile")}</div>
          </details>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
                {timeline.slice(0, TIMELINE_FIRST).map((t, i) => <TimelineItem key={i} t={t} />)}
              </ol>
            )}
            {timeline.length > TIMELINE_FIRST ? (
              <details className="group border-t border-border">
                <summary className="flex min-h-11 cursor-pointer items-center gap-1.5 pt-2 text-sm font-semibold text-primary">
                  <ChevronDown size={16} aria-hidden className="transition-transform group-open:rotate-180" />
                  Ältere Einträge ({Math.min(timeline.length, TIMELINE_MAX) - TIMELINE_FIRST})
                </summary>
                <ol className="flex flex-col">
                  {timeline.slice(TIMELINE_FIRST, TIMELINE_MAX).map((t, i) => <TimelineItem key={i} t={t} />)}
                </ol>
              </details>
            ) : null}
          </Card>

          {auth.can("medical.read") ? (
            <Card>
              <CardTitle action={<Link href={`/kunden/${p.id}/fotos`} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary">Alle Fotos & Vergleich</Link>}>Fotos</CardTitle>
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
                        <figcaption className="px-2 py-1 text-xs text-muted">{dateDe(m.takenAt)}{m.toe ? ` · ${m.footSide === "left" ? "li" : "re"} D${m.toe}` : ""}</figcaption>
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
            <div className="flex flex-col gap-3 text-[15px]">
              {address ? (
                <div className="flex items-start gap-2">
                  <MapPin size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0">
                    <p className="sr-only">Adresse</p>
                    <p>{address}</p>
                    {/* Nur die Adresse geht an Google Maps, kein Name, keine Gesundheitsdaten */}
                    <a className="inline-flex min-h-11 items-center text-sm font-semibold text-primary" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}>Route öffnen</a>
                  </div>
                </div>
              ) : null}
              {phone ? (
                <a href={`tel:${phone}`} className="flex min-h-11 items-center gap-2 font-semibold hover:text-primary"><Phone size={18} aria-hidden /> {phone}</a>
              ) : null}
              {waNumber && waAllowed ? (
                <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 font-semibold hover:text-primary"><MessageCircle size={18} aria-hidden /> WhatsApp</a>
              ) : null}
              {p.email ? <a href={`mailto:${p.email}`} className="flex min-h-11 items-center break-all font-semibold hover:text-primary">{p.email}</a> : null}
              {/* Definitionsliste nur mit gültigen Paaren (dt/dd je Zeile) – Screenreader lesen „Geburtsdatum: …“ */}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <div className="contents">
                  <dt className="text-muted">Geburtsdatum</dt>
                  <dd>{dateDe(p.birthDate)}</dd>
                </div>
                <div className="contents">
                  <dt className="text-muted">Hausarzt</dt>
                  <dd className="wrap-break-word">{p.gpName ?? "–"}</dd>
                </div>
                <div className="contents">
                  <dt className="text-muted">Bevorzugt</dt>
                  <dd>{p.preferredChannel === "none" ? "–" : p.preferredChannel}</dd>
                </div>
              </dl>
              {p.notes ? <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">{p.notes}</p> : null}
            </div>
          </Card>

          <Card>
            <CardTitle>Einwilligungen</CardTitle>
            <ul className="flex flex-col gap-2">
              {Object.entries(CONSENT_LABELS).map(([type, label]) => {
                const c = consents.get(type);
                return (
                  <li key={type} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="min-w-0 flex-[1_1_10rem]">{label}</span>
                    {c ? <Badge tone={c.granted ? "primary" : "neutral"}>{c.granted ? `ja · ${dateDe(c.recordedAt)}` : "nein"}</Badge> : <Badge>offen</Badge>}
                    {auth.can("patients.write") ? (
                      <form action={recordConsentAction}>
                        <input type="hidden" name="patientId" value={p.id} />
                        <input type="hidden" name="type" value={type} />
                        <input type="hidden" name="granted" value={c?.granted ? "0" : "1"} />
                        <button className="inline-flex h-11 items-center rounded-lg px-2.5 text-sm font-semibold text-primary hover:bg-surface-2" type="submit">
                          {c?.granted ? "widerrufen" : "erteilt"}
                        </button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-[13px] leading-5 text-muted">Die Behandlungsdoku selbst braucht keine Einwilligung (Art. 9 Abs. 2 lit. h DSGVO). Jede Änderung wird mit Zeitpunkt protokolliert.</p>
          </Card>

          {auth.can("appointments.write") && !deceased ? <WaitlistCard auth={auth} patientId={p.id} /> : null}

          <Card>
            <CardTitle>Datenschutz</CardTitle>
            <div className="flex flex-col gap-2">
              <LinkButton variant="secondary" href={`/api/patients/${p.id}/export`}><Download size={18} aria-hidden /> Auskunft (Art. 15) als JSON</LinkButton>
              <LinkButton variant="secondary" href={`/kunden/${p.id}/akte-drucken`}>Akte drucken / PDF</LinkButton>
              {auth.can("patients.write") && !deceased ? <PortalLinkButton patientId={p.id} /> : null}
            </div>
          </Card>

          {deceasedCard ? <DeceasedCard id={p.id} info={deceasedCard.info} futureOwn={deceasedCard.futureOwn} futureFeed={deceasedCard.futureFeed} /> : null}
        </div>
      </div>
    </div>
  );
}
