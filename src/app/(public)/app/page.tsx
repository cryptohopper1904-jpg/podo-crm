import { LinkButton } from "@/components/ui";
import { InstallGuide } from "@/components/pwa/install-guide";
import { pageMeta } from "../_content/site";
import { trademarkNotice } from "@/lib/pwa/app-meta";

export const metadata = pageMeta({
  title: "PodoHero als App",
  description: "PodoHero auf iPhone, iPad, Android-Tablet oder Computer als App installieren – ohne App Store, direkt aus dem Browser.",
  path: "/app",
});

const FACTS = [
  ["Ohne App Store", "Sie müssen nichts aus einem App Store laden: PodoHero wird aus dem Browser auf den Home-Bildschirm gelegt."],
  ["Gleicher Stand überall", "iPad in der Behandlung, Computer am Empfang, Smartphone beim Hausbesuch: alle arbeiten mit denselben Daten. Updates kommen automatisch – ein Tipp auf „Neu laden“ genügt."],
  ["Keine Patientendaten auf dem Gerät", "Termine, Akten und Fotos werden immer frisch vom Server geladen und nicht für die Offline-Nutzung auf dem Gerät gespeichert. Auf dem Gerät liegen nur die Anmeldung und Programmdateien. Ohne Verbindung zeigt die App einen Hinweis."],
] as const;

/** Kurze, sachliche Infoseite zur installierbaren Web-App (öffentlich, ohne Praxisdaten). */
export default function AppInfoPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="font-display text-3xl font-semibold sm:text-4xl">PodoHero als App</h1>
      <p className="mt-4 text-lg text-muted">
        PodoHero läuft im Browser und lässt sich auf iPhone, iPad, Android-Geräten und am Computer wie eine App installieren:
        mit eigenem Symbol, im Vollbild und ohne Browserleiste.
      </p>
      <p className="mt-3 text-[15px] text-muted">
        PodoHero ist eine Web-App – es gibt keine Version im App Store oder bei Google Play. Für die Nutzung ist eine
        Internetverbindung nötig.
      </p>
      <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FACTS.map(([title, text]) => (
          <li key={title} className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-muted">{text}</p>
          </li>
        ))}
      </ul>
      <section aria-labelledby="anleitung" className="mt-10">
        <h2 id="anleitung" className="mb-4 font-display text-2xl font-semibold">So installieren Sie PodoHero</h2>
        <InstallGuide headingLevel={3} />
        <p className="mt-4 text-sm text-muted">Nutzen Sie für die Praxis nur Geräte mit Code-Sperre.</p>
        <p className="mt-2 text-[13px] text-muted">{trademarkNotice({ googlePlay: true })}</p>
      </section>
      <div className="mt-10 flex flex-wrap gap-3">
        <LinkButton href="/login">Anmelden</LinkButton>
        <LinkButton href="/einrichtung" variant="secondary">Kostenlos testen</LinkButton>
      </div>
    </div>
  );
}
