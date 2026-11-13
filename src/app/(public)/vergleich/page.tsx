import Link from "next/link";
import { ArrowRight, Check, Footprints } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { COMPARISON_STAND, COMPETITORS, PODO } from "../_content/competitors";
import { Breadcrumbs, FaqList } from "../_content/faq-list";
import { breadcrumbLd, faqLd, JsonLd } from "../_content/json-ld";
import { pageMeta } from "../_content/site";


export const metadata = pageMeta({
  title: "Podologie-Software im Vergleich",
  description:
    "Praxissoftware für Podologie vergleichen: PodoHero neben pododesk, tinana und buchnerFLOW – sachlich, mit Quellen von den Herstellerwebsites und Stand-Angabe.",
  path: "/vergleich",
});

const CRITERIA = [
  ["Nur Podologie oder alle Heilmittel?", "Software für mehrere Heilmittel-Berufe deckt viel ab. Eine reine Podologie-Software kann dafür Fußschema, Nagelspangen, Hygiene und Pflegeheime tiefer abbilden."],
  ["GKV: direkt oder über ein Abrechnungszentrum?", "Manche Programme rechnen nach § 302 SGB V direkt mit den Kassen ab, andere übergeben an ein Abrechnungszentrum. Beides hat Kosten und Aufwand – vergleichen Sie Gebühren und Zahlungsziele."],
  ["Arbeiten am Behandlungsstuhl", "Wie schnell ist die Doku auf dem iPad? Fotos direkt aus der Kamera, Befunde antippen, Sterilgut-Charge erfassen?"],
  ["Selbstzahler und Patientenbindung", "Online-Buchung, Erinnerungen, Patientenportal, Gutscheine und Kasse sind für viele Podologie-Praxen genauso wichtig wie die Kassenabrechnung."],
  ["Datenschutz und Hosting", "Wo liegen die Daten? Gibt es einen Auftragsverarbeitungsvertrag, Zwei-Faktor-Anmeldung und einen vollständigen Datenexport?"],
  ["Preise und Einstieg", "Sind Preise öffentlich? Gibt es eine Testphase oder einen kostenlosen Tarif? Netto- und Bruttopreise beim Vergleich beachten."],
] as const;

const FAQ = [
  ["Ist dieser Vergleich neutral?", "Er stammt von PodoHero und ist daher nicht unabhängig. Wir vergleichen nur nachprüfbare Eigenschaften, nennen zu jeder Angabe über andere Anbieter die Quelle auf deren Website und den Stand. Was dort nicht steht, kennzeichnen wir als „nicht angegeben“ – das heißt nicht, dass es die Funktion nicht gibt."],
  ["Warum sind nicht alle Programme aufgeführt?", "Wir nehmen nur Anbieter auf, deren Website Podologie ausdrücklich als Zielgruppe nennt und deren Angaben wir öffentlich prüfen konnten. Weitere Vergleiche folgen."],
  ["Kann PodoHero direkt mit den Krankenkassen abrechnen?", "Nein. PodoHero bereitet Verordnungen bis zur Abrechnungsreife vor und übergibt sie per Export an ein Abrechnungszentrum, das die Übermittlung nach § 302 SGB V übernimmt."],
  ["Wie wechsle ich zu PodoHero?", "Patientendaten lassen sich aus einer Excel-Vorlage oder als Doctolib-CSV importieren; Doctolib-Termine können per Kalender-Abo übernommen werden. Details auf der Seite „Wechseln zu PodoHero“."],
] as const;

export default function ComparisonHub() {
  const trail = [{ name: "Vergleich", path: "/vergleich" }];
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), faqLd(FAQ)]} />
      <Breadcrumbs trail={trail} />
      <header className="mt-6 max-w-3xl">
        <Badge tone="primary"><Footprints size={14} aria-hidden className="mr-1" /> Gebaut nur für Podologie</Badge>
        <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">Podologie-Software im Vergleich</h1>
        <p className="mt-4 text-lg text-muted">
          Welche Praxissoftware passt zu Ihrer Podologie-Praxis? Hier finden Sie sachliche Gegenüberstellungen – mit Quellen von den
          Herstellerwebsites und Stand {COMPARISON_STAND}. Angaben ohne Gewähr.
        </p>
      </header>

      <section aria-labelledby="anbieter" className="mt-10">
        <h2 id="anbieter" className="font-display text-2xl font-semibold">PodoHero im Vergleich mit …</h2>
        <ul className="mt-4 grid gap-4 md:grid-cols-3">
          {COMPETITORS.map((c) => (
            <li key={c.slug}>
              <Link href={`/vergleich/${c.slug}`} className="group flex h-full flex-col rounded-[var(--radius-card)] border border-border bg-surface p-6 hover:border-primary">
                <span className="font-display text-xl font-semibold group-hover:text-primary">PodoHero und {c.name}</span>
                <span className="mt-2 flex-1 text-[15px] text-muted">{c.summary}</span>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                  Zum Vergleich <ArrowRight size={16} aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="podo-kurz" className="mt-12 rounded-[var(--radius-card)] border border-border bg-surface p-6">
        <h2 id="podo-kurz" className="font-display text-2xl font-semibold">PodoHero auf einen Blick</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {[PODO.audience, PODO.footDoc, PODO.booking, PODO.invoices, PODO.hygiene, PODO.carehome, PODO.gkv, PODO.hosting].map((t) => (
            <li key={t} className="flex gap-2.5 text-[15px]">
              <Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" /> <span>{t.charAt(0).toUpperCase() + t.slice(1)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="kriterien" className="mt-12">
        <h2 id="kriterien" className="font-display text-2xl font-semibold">Worauf Sie beim Vergleich achten sollten</h2>
        <dl className="mt-4 grid gap-4 md:grid-cols-2">
          {CRITERIA.map(([t, d]) => (
            <div key={t} className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
              <dt className="font-semibold">{t}</dt>
              <dd className="mt-1 text-[15px] text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-12">
        <FaqList items={FAQ} />
      </div>

      <section className="mt-12 flex flex-col items-start gap-4 rounded-[24px] bg-primary px-6 py-8 text-on-primary sm:px-10 md:flex-row md:items-center">
        <div className="flex-1">
          <h2 className="font-display text-2xl font-semibold">Selbst ausprobieren statt nur vergleichen</h2>
          <p className="mt-1 opacity-90">30 Tage kostenlos, danach auf Wunsch im kostenlosen Tarif weiter (bis 20 Patient:innen).</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">Kostenlos testen</LinkButton>
          <LinkButton href="/wechseln" variant="secondary" className="h-12 px-6 text-base">Wechsel planen</LinkButton>
        </div>
      </section>

      <p className="mt-8 text-xs text-muted">
        Produkt- und Firmennamen werden nur zur Identifikation genannt und sind ggf. Marken ihrer Inhaber. PodoHero steht in keiner Verbindung zu den
        genannten Anbietern. Angaben zu anderen Produkten ohne Gewähr, Quelle: jeweilige Herstellerwebsite, Stand {COMPARISON_STAND}. Hinweise auf
        Fehler nehmen wir gern auf und korrigieren sie umgehend.
      </p>
    </div>
  );
}
