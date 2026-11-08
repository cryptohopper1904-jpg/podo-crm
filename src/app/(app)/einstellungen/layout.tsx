import Link from "next/link";
import { requireAuth } from "@/lib/auth/session";

const TABS = [
  ["praxis", "Praxis"],
  ["team", "Team & Rollen"],
  ["leistungen", "Leistungen"],
  ["schnittstellen", "Schnittstellen"],
  ["erinnerungen", "Erinnerungen"],
  ["import", "Import"],
  ["sicherheit", "Sicherheit"],
  ["protokoll", "Zugriffsprotokoll"],
] as const;

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 font-display text-3xl font-semibold">Einstellungen</h1>
      <nav aria-label="Einstellungen" className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
        {TABS.map(([href, label]) => (
          <Link key={href} href={`/einstellungen/${href}`} className="whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold hover:bg-surface-2">{label}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
