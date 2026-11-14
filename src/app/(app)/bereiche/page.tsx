import Link from "next/link";
import { AreaOverview } from "@/components/app-nav";
import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { VIEW_LEVEL_LABELS } from "@/lib/view-level";
import { navAllowed, navBadges } from "@/server/nav";
import { currentViewLevel } from "@/server/view-level";

export const metadata = { title: "Alle Bereiche" };

/** Alle Bereiche, die die Person nutzen darf – auch die, die ihre Ansicht in der Navigation ausblendet (v. a. fürs Handy). */
export default async function AreasPage() {
  const auth = await requireAuth();
  const level = await currentViewLevel();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Alle Bereiche"
        subtitle={
          <>
            Ansicht: {VIEW_LEVEL_LABELS[level]}
            {auth.support ? null : (
              <>
                {" · "}
                <Link href="/einstellungen/ansicht" className="font-semibold text-primary hover:underline">ändern</Link>
              </>
            )}
          </>
        }
      />
      <AreaOverview allowed={navAllowed(auth)} level={level} badges={await navBadges(auth)} personal={!auth.support} />
    </div>
  );
}
