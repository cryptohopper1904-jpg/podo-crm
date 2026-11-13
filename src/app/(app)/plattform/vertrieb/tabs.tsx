"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const TABS = [
  { href: "/plattform/vertrieb", label: "Pipeline" },
  { href: "/plattform/vertrieb/kampagnen", label: "Kampagnen" },
  { href: "/plattform/vertrieb/aktionscodes", label: "Aktionscodes" },
  { href: "/plattform/vertrieb/import", label: "CSV-Import" },
  { href: "/plattform/vertrieb/vorlagen", label: "Vorlagen" },
  { href: "/plattform/vertrieb/einstellungen", label: "Einstellungen & Sperrliste" },
];

export function VertriebTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Vertrieb" className="mt-5 flex flex-wrap gap-2 border-b border-border pb-3">
      {TABS.map((t) => {
        const active = t.href === "/plattform/vertrieb" ? path === t.href || /^\/plattform\/vertrieb\/(neu|[0-9a-f-]{36})$/.test(path) : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cx("rounded-xl px-3 py-2 text-sm font-semibold", active ? "bg-primary-soft text-primary-soft-text" : "text-text hover:bg-surface-2")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
