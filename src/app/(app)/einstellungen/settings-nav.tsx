"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Einstellungs-Navigation in Gruppen – bricht um statt seitlich zu scrollen. */
export const SETTINGS_GROUPS = [
  {
    label: "Praxis",
    tabs: [
      ["praxis", "Praxisdaten"],
      ["team", "Team & Rollen"],
      ["leistungen", "Leistungen"],
      ["erinnerungen", "Erinnerungen"],
      ["website", "Website"],
    ],
  },
  {
    label: "Verbindungen",
    tabs: [
      ["schnittstellen", "Schnittstellen"],
      ["ti", "TI & KIM"],
      ["ocr", "Verordnungs-OCR"],
      ["import", "Import"],
    ],
  },
  {
    label: "Sicherheit & Daten",
    tabs: [
      ["sicherheit", "Sicherheit"],
      ["protokoll", "Zugriffsprotokoll"],
      ["support", "Support-Zugriff"],
      ["daten", "Daten & Kündigung"],
    ],
  },
  {
    label: "Vertrag",
    tabs: [["abo", "Abo & Tarif"]],
  },
] as const;

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Einstellungen" className="mb-6 grid gap-3 rounded-xl border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.label} className="min-w-0">
          <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</div>
          <ul className="flex flex-wrap gap-1">
            {g.tabs.map(([href, label]) => {
              const url = `/einstellungen/${href}`;
              const active = pathname === url || pathname.startsWith(url + "/");
              return (
                <li key={href}>
                  <Link
                    href={url}
                    aria-current={active ? "page" : undefined}
                    className={`inline-block rounded-lg px-3 py-2 text-sm font-semibold ${active ? "bg-primary text-on-primary" : "hover:bg-surface-2"}`}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
