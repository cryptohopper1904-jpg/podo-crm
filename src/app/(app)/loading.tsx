/**
 * Ladezustand beim Wechsel zwischen App-Seiten (langsame Mobilverbindung): Kopfzeile, Navigation und untere Leiste
 * (Layout) bleiben stehen, im Inhaltsbereich erscheint sofort ein Platzhalter – kein „nichts passiert“ nach dem Tippen.
 */
export default function AppLoading() {
  const block = "animate-pulse rounded-[var(--radius-card)] bg-surface-2 motion-reduce:animate-none";
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-7xl">
      <span className="sr-only">Seite wird geladen …</span>
      <div aria-hidden className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className={`${block} h-4 w-32 rounded-md`} />
          <div className={`${block} h-9 w-64 max-w-full rounded-lg`} />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className={`${block} h-28`} />
          <div className={`${block} h-28`} />
          <div className={`${block} h-28`} />
        </div>
        <div className={`${block} h-64`} />
      </div>
    </div>
  );
}
