import { NOT_INSTALLABLE } from "@/lib/pwa/app-meta";

/** Patientenseiten: nicht als Praxis-App „PodoHero“ installierbar (src/lib/pwa/app-meta.ts) */
export const metadata = NOT_INSTALLABLE;

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
