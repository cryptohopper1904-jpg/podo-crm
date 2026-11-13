"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/produkte", "Katalog"],
  ["/produkte/bestand", "Bestand"],
  ["/produkte/wareneingang", "Wareneingang"],
  ["/produkte/nachbestellen", "Nachbestellen"],
  ["/produkte/lieferanten", "Lieferanten"],
] as const;

export function ProductTabs() {
  const path = usePathname();
  const active = (href: string) =>
    href === "/produkte" ? path === href || (/^\/produkte\/[^/]+$/.test(path) && !TABS.some(([h]) => h === path)) : path === href || path.startsWith(href + "/");
  return (
    <nav aria-label="Produkte" className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
      {TABS.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold ${active(href) ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
