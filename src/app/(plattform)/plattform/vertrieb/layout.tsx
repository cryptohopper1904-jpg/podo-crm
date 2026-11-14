import Link from "next/link";
import { UWG_NOTE } from "@/lib/vertrieb/constants";
import { requirePlatformAdmin } from "@/server/platform";
import { VertriebTabs } from "./tabs";

/** Vertrieb (Plattform-Betreiber): nur Plattform-Admin mit aktiver 2FA (sonst 404). Hinweis zu § 7 UWG immer sichtbar. */
export default async function VertriebLayout({ children }: LayoutProps<"/plattform/vertrieb">) {
  await requirePlatformAdmin();
  return (
    <div className="mx-auto max-w-7xl">
      <p className="text-sm text-muted">
        <Link href="/plattform" className="font-semibold text-primary">Plattform</Link> / Vertrieb
      </p>
      <h1 className="font-display text-3xl font-semibold">Vertrieb</h1>
      <p role="note" className="mt-3 rounded-xl border border-border bg-warn-soft px-4 py-3 text-sm text-warn-soft-text">{UWG_NOTE}</p>
      <VertriebTabs />
      <div className="mt-6">{children}</div>
    </div>
  );
}
