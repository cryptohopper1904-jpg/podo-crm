import Link from "next/link";

export default function NoAccess() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-display text-3xl font-semibold">Kein Zugriff</h1>
      <p className="max-w-md text-muted">Deine Rolle darf diesen Bereich nicht sehen. Bitte wende dich an die Praxisinhaberin oder den Praxisinhaber.</p>
      <Link href="/heute" className="font-semibold text-primary">Zur Startseite</Link>
    </main>
  );
}
