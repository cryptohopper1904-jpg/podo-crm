import { requireAuth } from "@/lib/auth/session";
import { requireFeature } from "@/server/features";

/** Praxis nur für Privat-/Selbstzahler: Verordnungen ausgeblendet → Weiterleitung mit Hinweis (src/lib/features.ts). */
export default async function PrescriptionsLayout({ children }: { children: React.ReactNode }) {
  requireFeature(await requireAuth(), "verordnungen");
  return children;
}
