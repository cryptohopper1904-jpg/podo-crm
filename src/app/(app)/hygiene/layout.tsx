import Link from "next/link";
import { requireAuth } from "@/lib/auth/session";
import { canViewHygiene, canViewMaterials } from "./access";

export default async function HygieneLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  const tabs = [
    ...(canViewHygiene(auth)
      ? [
          ["/hygiene", "Übersicht"],
          ["/hygiene/chargen", "Sterilgut-Chargen"],
          ["/hygiene/geraete", "Geräte & Gerätebuch"],
        ]
      : []),
    ...(canViewMaterials(auth) ? [["/hygiene/material", "Material"]] : []),
  ];
  return (
    <div className="mx-auto max-w-6xl">
      <div className="no-print">
        <h1 className="mb-4 font-display text-3xl font-semibold">Hygiene</h1>
        <nav aria-label="Hygiene" className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
          {tabs.map(([href, label]) => (
            <Link key={href} href={href} className="whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold hover:bg-surface-2">
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
