import Link from "next/link";
import { LogOut, Sparkles } from "lucide-react";
import { and, count, eq } from "drizzle-orm";
import { AccessBanner } from "@/components/access-banner";
import { cookies } from "next/headers";
import { BottomNav, type NavKey } from "@/components/app-nav";
import { NAV_COOKIE, Sidebar } from "@/components/sidebar";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoginChangelog } from "@/components/login-changelog";
import { withOrg } from "@/db";
import { messages } from "@/db/schema";
import { getAuth, getSession, requireAuth } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { removeHiddenNav } from "@/lib/features";
import { OrgSwitcher } from "@/components/org-switcher";
import { loadSwitcherModel } from "@/server/org-switcher";
import type { SwitcherModel } from "@/lib/org-switcher";
import { logoutAction } from "../(auth)/actions";

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
      <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-8">
        <Link href="/plattform"><Logo /></Link>
        <span className="hidden text-sm text-muted sm:inline">Plattform-Konsole · {name}</span>
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
      <main className="flex-1 px-4 pb-10 pt-6 lg:px-8">
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
  const allowed: NavKey[] = ["heute"];
  if (auth.can("appointments.read")) allowed.push("kalender", "touren");
  if (auth.can("patients.read")) allowed.push("kunden", "verordnungen", "pflegeheime");
  if (auth.can("medical.write")) allowed.push("doku");
  if (auth.can("messages.read")) allowed.push("posteingang", "telefon", "bewertungen");
  if (auth.can("invoices.read")) allowed.push("rechnungen", "gutscheine");
  if (auth.can("cash.read")) allowed.push("kasse");
  if (auth.can("medical.read") || auth.can("patients.write")) allowed.push("hygiene");
  if (auth.role !== "accountant") allowed.push("team");
  allowed.push("news");
  if (auth.can("finance.read")) allowed.push("auswertung");
  if (auth.can("settings.manage")) allowed.push("einstellungen");
  if (auth.user.isPlatformAdmin && auth.user.totpEnabled && !auth.support) allowed.push("plattform");
  removeHiddenNav(auth.organization, allowed); // Kassen-Themen bei „nur Privat-/Selbstzahler“ (src/lib/features.ts)

  const switcher = await loadSwitcherModel({
    userId: auth.user.id,
    currentOrgId: auth.organization.id,
    isPlatformAdmin: auth.user.isPlatformAdmin,
    totpEnabled: auth.user.totpEnabled,
    support: !!auth.support,
  });

  let unread = 0;
  if (auth.can("messages.read")) {
    const [r] = await withOrg(auth.organization.id, (tx) =>
      tx
        .select({ n: count() })
        .from(messages)
        .where(and(eq(messages.organizationId, auth.organization.id), eq(messages.status, "new"))),
    );
    unread = r?.n ?? 0;
  }

  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === "collapsed";

  return (
    <div className="flex min-h-screen">
      <Sidebar
        initialCollapsed={navCollapsed}
        allowed={allowed}
        badges={{ posteingang: unread }}
        userName={auth.user.name}
        userMeta={`${ROLE_LABELS[auth.role]} · ${auth.organization.name}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-8">
          <Link href="/heute" className="lg:hidden">
            <Logo />
          </Link>
          <form action="/kunden" className="ml-auto hidden max-w-sm flex-1 md:block">
            <label className="sr-only" htmlFor="q">Suche</label>
            <input
              id="q"
              name="q"
              placeholder="Kunde suchen …"
              className="h-11 w-full rounded-xl border border-border bg-bg px-3.5 text-[15px] placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </form>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
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
        <main className="flex-1 px-4 pb-28 pt-6 lg:px-8 lg:pb-10">{children}</main>
      </div>
      <BottomNav allowed={allowed} />
      {auth.support ? null : <LoginChangelog />}
    </div>
  );
}
