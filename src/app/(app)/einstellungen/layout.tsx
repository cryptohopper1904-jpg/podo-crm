import { eq } from "drizzle-orm";
import { BookingImprintNotice } from "@/components/booking-imprint-notice";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { avvAcceptedAtLeast, storedLegalAcceptance } from "@/lib/legal";
import { AvvBanner } from "./avv-banner";
import { requireAuth } from "@/lib/auth/session";
import { settingsGroupsFor } from "@/server/features";
import { bookingBlockedByImprint } from "@/server/portal-booking";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  // Online-Buchung eingeschaltet, aber wegen fehlender Impressumsangaben gesperrt → Hinweis über allen Bereichen
  const imprintMissing = auth.can("settings.manage") ? await bookingBlockedByImprint(auth.organization.id) : null;
  // Aktualisierte AVV noch nicht akzeptiert → Hinweis für die Inhaber:in (nicht per Support-Freigabe)
  let avvPrevious: string | null | undefined;
  if (auth.role === "owner" && !auth.support) {
    const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
    if (!avvAcceptedAtLeast(o?.settings)) avvPrevious = storedLegalAcceptance(o?.settings)?.avv ?? null;
  }
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 font-display text-3xl font-semibold">Einstellungen</h1>
      {/* ab xl: Navigation links, Inhalt rechts; darunter Auswahlliste über dem Inhalt */}
      <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-8">
        <SettingsNav groups={await settingsGroupsFor(auth)} />
        <div className="min-w-0">
          {avvPrevious !== undefined ? <div className="mb-6"><AvvBanner previous={avvPrevious} /></div> : null}
          {imprintMissing ? <div className="mb-6"><BookingImprintNotice missing={imprintMissing} /></div> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
