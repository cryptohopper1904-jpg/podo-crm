import Link from "next/link";
import { LogOut, Sparkles } from "lucide-react";
import { AccessBanner } from "@/components/access-banner";
import { cookies } from "next/headers";
import { BottomNav } from "@/components/app-nav";
import { Sidebar } from "@/components/sidebar";
import { NAV_COOKIE } from "@/lib/nav";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoginChangelog } from "@/components/login-changelog";
import { getAuth, getSession, requireAuth } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { navAllowed, navBadges } from "@/server/nav";
import { currentViewLevel } from "@/server/view-level";
import { OrgSwitcher } from "@/components/org-switcher";
import { PatientSearch } from "@/components/patient-search";
import { loadSwitcherModel } from "@/server/org-switcher";
import type { SwitcherModel } from "@/lib/org-switcher";
import { logoutAction } from "../(auth)/actions";
import type { Metadata } from "next";
import { appLayoutMetadata } from "@/lib/pwa/app-meta";
import { PwaClient } from "@/components/pwa/pwa-client";
import { InstallBanner } from "@/components/pwa/install-banner";

/** iOS-Startbildschirme der installierten App (src/lib/pwa/startup-images.ts) */
export const metadata: Metadata = appLayoutMetadata();

/**
 * Kopfzeile: in der installierten App (viewport-fit=cover) Abstand zu Statusleiste/Notch und im Querformat zu den
 * seitlichen Aussparungen des iPhones (env(safe-area-inset-*), sonst 0).
 */
const headerCls =
  "no-print sticky top-0 z-20 flex min-h-[calc(4rem+env(safe-area-inset-top))] items-center gap-3 border-b border-border bg-surface/90 pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur lg:pr-[max(2rem,env(safe-area-inset-right))] lg:pl-8";

/** Dauerhafter Zugang zu den Neuigkeiten (Popup „Neu in PodoHero“ erscheint einmal je Anmeldung) */
function NewsLink() {
  return (
    <Link href="/neuigkeiten" aria-label="Neuigkeiten" title="Neuigkeiten" className="inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2">
      <Sparkles size={19} aria-hidden />
    </Link>
  );
}

/**
 * Plattform-Admin OHNE Praxis-Mitgliedschaft (z. B. per BOOTSTRAP_ADMIN_* angelegt): schlanke Hülle nur für
 * die Plattform-Konsole. Alle anderen Seiten prüfen selbst requireAuth() und leiten mangels Praxis zum Login,
 * das wiederum zur Konsole bzw. zur 2FA-Einrichtung weiterleitet. Die Konsole verlangt aktive 2FA.
 */
function PlatformOnlyShell({ name, totpEnabled, switcher, children }: { name: string; totpEnabled: boolean; switcher: SwitcherModel | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className={headerCls}>
        <Link href="/plattform"><Logo /></Link>
        <span className="hidden text-sm text-muted sm:inline">Plattform-Konsole · {name}</span>
        {totpEnabled ? <Link href="/plattform/vertrieb" className="text-sm font-semibold text-primary">Vertrieb</Link> : null}
        <div className="ml-auto flex items-center gap-2">
          {switcher?.show ? <OrgSwitcher model={{ ...switcher, platformLink: false }} /> : null}
          <NewsLink />
          <ThemeToggle />
          <form action={logoutAction}>
            <button type="submit" aria-label="Abmelden" title="Abmelden" className="inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2">
              <LogOut size={19} aria-hidden />
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 pt-6 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] lg:px-8">
        {totpEnabled ? children : (
          <div className="mx-auto max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-6">
            <h1 className="font-display text-2xl font-semibold">Zwei-Faktor-Anmeldung erforderlich</h1>
            <p className="mt-2 text-sm text-muted">Die Plattform-Konsole ist nur mit aktiver Zwei-Faktor-Anmeldung zugänglich.</p>
            <Link href="/login/2fa-einrichten" className="mt-4 inline-block font-semibold text-primary">Jetzt einrichten</Link>
          </div>
        )}
      </main>
      {totpEnabled ? <LoginChangelog /> : null}
    </div>
  );
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  if (!(await getAuth())) {
    const row = await getSession();
    if (row?.session.verified && !row.session.organizationId && row.user.isPlatformAdmin) {
      const switcher = row.user.totpEnabled
        ? await loadSwitcherModel({ userId: row.user.id, currentOrgId: null, isPlatformAdmin: true, totpEnabled: true, support: false })
        : null;
      return <PlatformOnlyShell name={row.user.name} totpEnabled={row.user.totpEnabled} switcher={switcher}>{children}</PlatformOnlyShell>;
    }
  }
  const auth = await requireAuth();
  const allowed = navAllowed(auth); // Rechte + Praxis-Schalter (src/server/nav.ts)

  const switcher = await loadSwitcherModel({
    userId: auth.user.id,
    currentOrgId: auth.organization.id,
    isPlatformAdmin: auth.user.isPlatformAdmin,
    totpEnabled: auth.user.totpEnabled,
    support: !!auth.support,
  });

  const badges = await navBadges(auth);
  const level = await currentViewLevel(); // persönliche Ansicht (src/lib/view-level.ts)

  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === "collapsed";

  return (
    <div className="flex min-h-screen">
      <Sidebar
        initialCollapsed={navCollapsed}
        allowed={allowed}
        badges={badges}
        userName={auth.user.name}
        userMeta={`${ROLE_LABELS[auth.role]} · ${auth.organization.name}`}
        level={level}
        canChangeView={!auth.support}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={headerCls}>
          <Link href="/heute" className="lg:hidden">
            <Logo />
          </Link>
          {auth.can("patients.read") ? <PatientSearch /> : null}
          <div className={`flex items-center gap-2 ${auth.can("patients.read") ? "" : "ml-auto"}`}>
            <OrgSwitcher model={switcher} />
            <NewsLink />
            <ThemeToggle />
            <form action={logoutAction}>
              <button
                type="submit"
                aria-label="Abmelden"
                title="Abmelden"
                className="inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2"
              >
                <LogOut size={19} aria-hidden />
              </button>
            </form>
          </div>
        </header>
        <AccessBanner auth={auth} />
        {auth.support ? null : <InstallBanner />}
        {/* unten Platz für die feste Leiste (BottomNav) samt Home-Indikator des iPhones */}
        <main className="flex-1 pt-6 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(7rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] lg:px-8 lg:pb-10">{children}</main>
      </div>
      <BottomNav allowed={allowed} level={level} badges={badges} />
      {auth.support ? null : <LoginChangelog />}
      <PwaClient />
    </div>
  );
}
