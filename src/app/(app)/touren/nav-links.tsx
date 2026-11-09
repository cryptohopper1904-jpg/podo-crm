import { Navigation } from "lucide-react";
import { navigationLinks } from "@/lib/routing/trip-log";

/** Navigation starten: öffnet Google Maps bzw. Apple Karten erst auf Klick (nur Zieladresse, kein Name). */
export function NavLinks({ address, big = false }: { address: string; big?: boolean }) {
  if (!address) return null;
  const l = navigationLinks(address);
  const cls = big
    ? "inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-on-primary hover:bg-primary-hover"
    : "inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2";
  return (
    <>
      <a href={l.google} target="_blank" rel="noopener noreferrer" className={cls}>
        <Navigation size={big ? 20 : 16} aria-hidden /> {big ? "Navigation starten (Google Maps)" : "Google Maps"}
      </a>
      <a href={l.apple} target="_blank" rel="noopener noreferrer" className={big ? cls.replace("bg-primary", "bg-surface border border-border").replace("text-on-primary", "text-text").replace("hover:bg-primary-hover", "hover:bg-surface-2") : cls}>
        <Navigation size={big ? 20 : 16} aria-hidden /> {big ? "Apple Karten" : "Apple Karten"}
      </a>
    </>
  );
}
