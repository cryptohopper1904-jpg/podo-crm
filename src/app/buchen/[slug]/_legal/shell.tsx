import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { practiceLegalLinks, type PracticeLegal } from "@/server/website";

/** Schlanke Hülle für Impressum/Datenschutz der Online-Buchung (Praxen ohne Website) */
export function BookingLegalShell({ legal, children }: { legal: PracticeLegal; children: React.ReactNode }) {
  const links = practiceLegalLinks(legal);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-bg">
        <div className="mx-auto flex min-h-16 max-w-3xl items-center gap-3 py-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          <Link href={`/buchen/${legal.slug}`} className="inline-flex min-h-11 min-w-0 items-center gap-1.5 font-semibold hover:text-primary">
            <ArrowLeft size={18} aria-hidden className="shrink-0" />
            <span className="truncate">Termin buchen · {legal.name}</span>
          </Link>
          <span className="ml-auto shrink-0"><ThemeToggle /></span>
        </div>
      </header>
      <main id="inhalt" className="flex-1">{children}</main>
      <BookingLegalFooter links={links} name={legal.name} />
    </div>
  );
}

/** Fußzeile mit Impressum und Datenschutzhinweisen der Praxis (Online-Buchung) */
export function BookingLegalFooter({ links, name }: { links: { imprint: string; privacy: string }; name: string }) {
  return (
    <footer className="border-t border-border">
      <nav aria-label={`Rechtliches ${name}`} className="mx-auto flex max-w-3xl flex-wrap gap-x-6 py-4 text-sm pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <Link href={links.imprint} className="inline-flex min-h-11 items-center font-medium hover:text-primary">Impressum</Link>
        <Link href={links.privacy} className="inline-flex min-h-11 items-center font-medium hover:text-primary">Datenschutz</Link>
      </nav>
    </footer>
  );
}
