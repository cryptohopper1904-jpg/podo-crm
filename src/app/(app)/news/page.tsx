import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, PageHeader, cx } from "@/components/ui";
import { db } from "@/db";
import { newsItems } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { NEWS_CATEGORIES } from "@/lib/news-sources";
import { refreshNewsAction } from "./actions";

export const metadata = { title: "News" };

export default async function NewsPage(props: PageProps<"/news">) {
  await requireAuth();
  const sp = await props.searchParams;
  const category = typeof sp.kategorie === "string" && (NEWS_CATEGORIES as readonly string[]).includes(sp.kategorie) ? sp.kategorie : "";
  const rows = await db
    .select()
    .from(newsItems)
    .where(category ? eq(newsItems.category, category) : undefined)
    .orderBy(desc(sql`coalesce(${newsItems.publishedAt}, ${newsItems.fetchedAt})`))
    .limit(100);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="News & Wissen"
        subtitle="Recht, Abrechnung, Techniken und Fortbildung für die Podologie"
        actions={<ActionForm action={refreshNewsAction} submit="Jetzt aktualisieren" className="flex items-center gap-2">{null}</ActionForm>}
      />
      <nav aria-label="Kategorien" className="mb-4 flex flex-wrap gap-1.5">
        {["", ...NEWS_CATEGORIES].map((c) => (
          <Link
            key={c || "alle"}
            href={c ? `/news?kategorie=${encodeURIComponent(c)}` : "/news"}
            className={cx("rounded-full border px-3 py-1.5 text-sm font-semibold", c === category ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-surface hover:bg-surface-2")}
          >
            {c || "Alle"}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Empty title="Noch keine Meldungen">Mit „Jetzt aktualisieren“ werden die hinterlegten Nachrichtenquellen abgerufen.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((n) => (
            <Card key={n.id}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone="info">{n.category}</Badge>
                {n.sponsored ? <Badge tone="warn">Anzeige</Badge> : null}
                <span>{n.source}</span>
                <span>· {dateDe(n.publishedAt ?? n.fetchedAt)}</span>
              </div>
              <a href={n.url} target="_blank" rel="noreferrer noopener" className="font-display text-lg font-semibold hover:underline">{n.title}</a>
              {n.summary ? <p className="mt-1 text-[15px] text-muted">{n.summary}</p> : null}
            </Card>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-muted">Zusammenfassungen sind automatisch erstellt und können Fehler enthalten – maßgeblich ist die verlinkte Originalquelle.</p>
    </div>
  );
}
