"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cx, fieldLabelCls } from "@/components/ui";
import type { SettingsGroup } from "@/lib/settings-tabs";

const urlOf = (href: string) => `/einstellungen/${href}`;

/**
 * Einstellungs-Navigation. Desktop (ab xl): linke Leiste mit Gruppenüberschriften, alle Einträge gleich hoch und
 * linksbündig, aktiver Eintrag mit Akzentbalken + zarter Fläche. iPad/Handy: kompakte Auswahlliste (mit Gruppen).
 * `groups` kommt bereits gefiltert vom Server (nur Bereiche, die die Rolle öffnen darf – settingsGroupsFor).
 */
export function SettingsNav({ groups }: { groups: SettingsGroup[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = (href: string) => pathname === urlOf(href) || pathname.startsWith(urlOf(href) + "/");
  const current = groups.flatMap((g) => g.tabs).find((t) => isActive(t.href));

  return (
    <>
      {/* iPad/Handy */}
      <label className="mb-6 flex flex-col gap-1.5 xl:hidden">
        <span className={fieldLabelCls}>Bereich</span>
        <span className="relative block">
          <select
            value={current?.href ?? ""}
            onChange={(e) => router.push(urlOf(e.target.value))}
            className="h-11 w-full appearance-none rounded-xl border border-border bg-surface pr-10 pl-3.5 text-[15px] font-semibold text-text focus:border-primary focus:outline-none"
          >
            {current ? null : <option value="">– Bereich wählen –</option>}
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.tabs.map((t) => (
                  <option key={t.href} value={t.href}>{t.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={18} aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-muted" />
        </span>
      </label>

      {/* Desktop */}
      <nav aria-label="Einstellungen" className="hidden xl:sticky xl:top-4 xl:block xl:self-start">
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-1 h-5 px-3 text-xs leading-5 font-semibold tracking-wide text-muted uppercase">{g.label}</p>
              <ul className="flex flex-col gap-0.5">
                {g.tabs.map((t) => {
                  const active = isActive(t.href);
                  return (
                    <li key={t.href}>
                      <Link
                        href={urlOf(t.href)}
                        aria-current={active ? "page" : undefined}
                        className={cx(
                          "relative flex h-10 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                          active ? "bg-primary-soft font-semibold text-primary-soft-text" : "text-text hover:bg-surface-2",
                        )}
                      >
                        {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-full bg-primary" /> : null}
                        <span className="truncate">{t.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
