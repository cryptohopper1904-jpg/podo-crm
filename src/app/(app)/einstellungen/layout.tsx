import { requireAuth } from "@/lib/auth/session";
import { hiddenSettingsTabs } from "@/server/features";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 font-display text-3xl font-semibold">Einstellungen</h1>
      <SettingsNav hidden={await hiddenSettingsTabs(auth)} />
      {children}
    </div>
  );
}
