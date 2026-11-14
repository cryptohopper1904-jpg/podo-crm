import { requireAuth } from "@/lib/auth/session";
import { canViewHygiene, canViewMaterials } from "./access";
import { HygieneNav } from "./hygiene-nav";

export default async function HygieneLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  const tabs: [string, string][] = [
    ...(canViewHygiene(auth)
      ? [
          ["/hygiene", "Übersicht"] as [string, string],
          ["/hygiene/chargen", "Sterilgut-Chargen"] as [string, string],
          ["/hygiene/geraete", "Geräte & Gerätebuch"] as [string, string],
        ]
      : []),
    ...(canViewMaterials(auth) ? [["/hygiene/material", "Material"] as [string, string]] : []),
  ];
  return (
    <div className="mx-auto max-w-6xl">
      <div className="no-print">
        <h1 className="mb-4 font-display text-3xl font-semibold">Hygiene</h1>
        <HygieneNav tabs={tabs} />
      </div>
      {children}
    </div>
  );
}
