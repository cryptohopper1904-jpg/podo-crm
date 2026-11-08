"use server";

import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { newsItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { categorizeNews, NEWS_SOURCES } from "@/lib/news-sources";
import { parseFeed, type FeedItem } from "@/lib/rss";
import { adapterFor } from "@/server/integrations";

export type NewsState = { error?: string; ok?: string } | undefined;

const PER_FEED = 15;

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "PodoCRM-News/0.1 (+https://podocrm.invalid)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error("Feed zu groß");
  return parseFeed(text).filter((i) => /^https?:\/\//.test(i.url)).slice(0, PER_FEED);
}

/** Lädt alle Feeds, fasst neue Meldungen zusammen (LLM bzw. Mock) und ordnet Kategorien zu. Öffentliche Daten – keine Patientendaten. */
export async function refreshNewsAction(): Promise<NewsState> {
  const auth = await requireAuth();
  const errors: string[] = [];
  const collected: { source: (typeof NEWS_SOURCES)[number]; item: FeedItem }[] = [];
  await Promise.all(
    NEWS_SOURCES.map(async (source) => {
      try {
        for (const item of await fetchFeed(source.url)) collected.push({ source, item });
      } catch (e) {
        errors.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}${source.verified ? "" : " (Feed-URL ungeprüft)"}`);
      }
    }),
  );
  if (collected.length === 0) return { error: `Keine Meldungen geladen. ${errors.join("; ")}` };

  const existing = new Set(
    (await db.select({ url: newsItems.url }).from(newsItems).where(inArray(newsItems.url, collected.map((c) => c.item.url)))).map((r) => r.url),
  );
  const fresh = collected.filter((c, i, arr) => !existing.has(c.item.url) && arr.findIndex((x) => x.item.url === c.item.url) === i);

  let summaries = new Map<string, string>();
  if (fresh.length) {
    try {
      const llm = await adapterFor(auth.organization.id, "llm");
      const res = await llm.summarizeNews(fresh.map((f) => ({ title: f.item.title, url: f.item.url, text: f.item.text })));
      summaries = new Map(res.map((r) => [r.url, r.summary]));
    } catch (e) {
      errors.push(`Zusammenfassung: ${e instanceof Error ? e.message : String(e)} – Anrisstext verwendet`);
    }
    await db
      .insert(newsItems)
      .values(
        fresh.map(({ source, item }) => ({
          source: source.name,
          title: item.title.slice(0, 500),
          url: item.url,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          summary: (summaries.get(item.url) ?? item.text).slice(0, 1200) || null,
          category: categorizeNews(`${item.title} ${item.text}`, source.defaultCategory),
          sponsored: source.sponsored ?? false,
        })),
      )
      .onConflictDoNothing({ target: newsItems.url });
  }
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "news.refresh", meta: { added: fresh.length, errors: errors.length } });
  revalidatePath("/news");
  return { ok: `${fresh.length} neue Meldungen.${errors.length ? ` Hinweise: ${errors.join("; ")}` : ""}` };
}
