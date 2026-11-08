import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { publicLinkInfo } from "@/server/anamnesis";
import { OnlineAnamnesisForm } from "./online-form";

// Token steht in der URL: nicht indexieren, nicht als Referrer weitergeben
export const metadata: Metadata = { title: "Anamnesebogen", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Öffentlicher Online-Anamnesebogen (Einmal-Link). Zeigt vom Patienten nur den Vornamen.
 * Hinweis: '/anamnese' muss in src/proxy.ts zur PUBLIC-Liste hinzugefügt werden.
 */
export default async function OnlineAnamnesisPage(props: PageProps<"/anamnese/[token]">) {
  const { token } = await props.params;
  const info = await publicLinkInfo(token);
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      {info ? (
        <>
          <p className="text-muted">{info.practiceName}</p>
          <h1 className="font-display text-3xl font-semibold">Anamnesebogen</h1>
          <p className="mt-3">
            {info.firstName ? `Hallo ${info.firstName}, ` : "Hallo, "}bitte beantworten Sie vor Ihrem Termin ein paar Fragen zu Ihrer Gesundheit.
            So können wir Sie sicher behandeln (z. B. bei Diabetes oder blutverdünnenden Medikamenten). Das dauert etwa 5 Minuten.
          </p>
          <p className="mt-3 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
            Ihre Angaben werden verschlüsselt übertragen und nur in Ihrer Kundenakte gespeichert. Der Link funktioniert nur einmal.
            Wenn Sie etwas nicht wissen, lassen Sie das Feld einfach leer.
          </p>
          <OnlineAnamnesisForm token={token} />
        </>
      ) : (
        <>
          <h1 className="font-display text-3xl font-semibold">Link nicht gültig</h1>
          <p className="mt-3">Dieser Link ist abgelaufen, wurde bereits verwendet oder ist ungültig. Bitte wenden Sie sich an Ihre Praxis – wir schicken Ihnen gern einen neuen Link.</p>
        </>
      )}
    </main>
  );
}
