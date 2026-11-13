import { requireAuth } from "@/lib/auth/session";
import { settingsGroupsFor } from "@/server/features";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 font-display text-3xl font-semibold">Einstellungen</h1>
      {/* ab xl: Navigation links, Inhalt rechts; darunter Auswahlliste über dem Inhalt */}
      <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-8">
        <SettingsNav groups={await settingsGroupsFor(auth)} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
