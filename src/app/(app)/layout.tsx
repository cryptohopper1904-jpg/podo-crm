import Link from "next/link";
import { LogOut } from "lucide-react";
import { and, count, eq } from "drizzle-orm";
import { AccessBanner } from "@/components/access-banner";
import { BottomNav, SideNav, type NavKey } from "@/components/app-nav";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { withOrg } from "@/db";
import { messages } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { logoutAction } from "../(auth)/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await requireAuth();
  const allowed: NavKey[] = ["heute"];
  if (auth.can("appointments.read")) allowed.push("kalender");
  if (auth.can("patients.read")) allowed.push("kunden", "verordnungen", "pflegeheime");
  if (auth.can("medical.write")) allowed.push("doku");
  if (auth.can("messages.read")) allowed.push("posteingang", "telefon", "bewertungen");
  if (auth.can("invoices.read")) allowed.push("rechnungen", "kasse", "gutscheine");
  if (auth.can("medical.read") || auth.can("patients.write")) allowed.push("hygiene");
  if (auth.role !== "accountant") allowed.push("team");
  allowed.push("news");
  if (auth.can("finance.read")) allowed.push("auswertung");
  if (auth.can("settings.manage")) allowed.push("einstellungen");
  if (auth.user.isPlatformAdmin && auth.user.totpEnabled && !auth.support) allowed.push("plattform");

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

  return (
    <div className="flex min-h-screen">
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-4 py-6 lg:flex">
        <Link href="/heute" className="px-2">
          <Logo />
        </Link>
        <SideNav allowed={allowed} badges={{ posteingang: unread }} />
        <div className="mt-auto rounded-xl bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{auth.user.name}</p>
          <p className="text-muted">{ROLE_LABELS[auth.role]} · {auth.organization.name}</p>
        </div>
      </aside>
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
    </div>
  );
}
