"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { segmentGroupCls, segmentItemCls } from "@/components/ui";

/**
 * Unternavigation Hygiene als Segment-Umschalter (wie Kalender/Rechnungen): aktiver Bereich markiert, bricht auf dem
 * Handy in eine zweite Zeile um statt seitlich (ohne Hinweis) zu scrollen. Client-Komponente, weil das Layout bei
 * Wechseln zwischen den Unterseiten nicht neu gerendert wird.
 */
export function HygieneNav({ tabs }: { tabs: [string, string][] }) {
  // Detailseite einer Charge (/hygiene/charge/…) gehört zu „Sterilgut-Chargen“
  const pathname = usePathname().replace(/^\/hygiene\/charge\//, "/hygiene/chargen/");
  // längster passender Präfix gewinnt (/hygiene/chargen vor /hygiene)
  const active = tabs.map(([href]) => href).filter((href) => pathname === href || pathname.startsWith(`${href}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Hygiene" className={`${segmentGroupCls} mb-6`}>
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} aria-current={href === active ? "page" : undefined} className={segmentItemCls(href === active)}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
