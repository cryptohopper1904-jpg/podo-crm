import { ArrowLeftRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { switchOrganizationAction } from "@/app/(auth)/actions";
import type { SwitcherModel } from "@/lib/org-switcher";

/** Auswahl Plattform / Praxen im App-Kopf (ohne Client-JS: <details> mit je einem Formular). */
export function OrgSwitcher({ model }: { model: SwitcherModel }) {
  if (!model.show && !model.platformLink) return null;
  const current = model.options.find((o) => o.current);
  return (
    <div className="flex items-center gap-2">
      {model.show ? (
        <details className="relative">
          <summary
            className="inline-flex h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-2"
            aria-label="Praxis wechseln"
          >
            <ArrowLeftRight size={17} aria-hidden />
            <span className="hidden max-w-48 truncate sm:inline">{current?.label ?? "Wechseln"}</span>
          </summary>
          <ul className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-border bg-surface p-1 shadow-lg">
            {model.options.map((o) => (
              <li key={o.value}>
                <form action={switchOrganizationAction}>
                  <input type="hidden" name="organizationId" value={o.value} />
                  <button
                    type="submit"
                    disabled={o.current}
                    aria-current={o.current ? "true" : undefined}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:cursor-default disabled:font-semibold"
                  >
                    <span className="truncate">{o.label}</span>
                    {o.demo ? <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted">Demo</span> : null}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {model.platformLink ? (
        <Link
          href="/plattform"
          aria-label="Zur Plattform-Konsole"
          title="Zur Plattform-Konsole"
          className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-2"
        >
          <ShieldCheck size={17} aria-hidden />
          <span className="hidden md:inline">Zur Plattform-Konsole</span>
        </Link>
      ) : null}
    </div>
  );
}

/** Button „Demo-Praxis öffnen“ (Plattform-Konsole) */
export function OpenDemoButton({ organizationId }: { organizationId: string }) {
  return (
    <form action={switchOrganizationAction}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <button type="submit" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
        Demo-Praxis öffnen
      </button>
    </form>
  );
}
