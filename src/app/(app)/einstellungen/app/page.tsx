import Link from "next/link";
import { Card, CardTitle } from "@/components/ui";
import { trademarkNotice } from "@/lib/pwa/app-meta";
import { InstallGuide } from "@/components/pwa/install-guide";
import { requireAuth } from "@/lib/auth/session";

export const metadata = { title: "App installieren" };

/** PodoHero als Web-App auf iPhone, iPad, Android oder dem Computer installieren (für alle Rollen, gilt pro Gerät). */
export default async function InstallAppSettings() {
  await requireAuth();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>App installieren</CardTitle>
        <p className="mb-4 text-[15px] text-muted">
          PodoHero lässt sich ohne App Store auf dem Home-Bildschirm ablegen. Die App startet dann im Vollbild ohne
          Browserleiste, Anmeldung und Funktionen bleiben gleich. Die Einrichtung gilt für dieses Gerät.
        </p>
        <InstallGuide headingLevel={3} />
      </Card>
      <Card>
        <CardTitle>Gut zu wissen</CardTitle>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px]">
          <li>
            Praxis- und Patientendaten werden von PodoHero nicht auf dem Gerät zwischengespeichert. Ausnahme: Dateien, die du
            selbst herunterlädst (z. B. PDFs, Exporte), liegen danach im Download-Ordner des Geräts.
          </li>
          <li>Ohne Internetverbindung zeigt die App nur einen Hinweis und lädt weiter, sobald die Verbindung zurück ist.</li>
          <li>Updates kommen von selbst. Bei einer neuen Version erscheint „Neue Version verfügbar – Neu laden“.</li>
          <li>In der installierten App gibt es keine Browser-Zurück-Taste – nutze die Zurück-Links oben auf den Seiten.</li>
          <li>Nutze für die Praxis nur Geräte mit Code-Sperre.</li>
          <li>Auf gemeinsam genutzten Geräten nach der Arbeit abmelden oder den Übergabe-Modus nutzen.</li>
        </ul>
        <p className="mt-4 text-sm">
          <Link href="/impressum" className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline">Impressum</Link>
          {" · "}
          <Link href="/datenschutz" className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline">Datenschutz</Link>
        </p>
        <p className="mt-2 text-[13px] text-muted">{trademarkNotice()}</p>
      </Card>
    </div>
  );
}
