"use server";

import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { newsItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { cleanNewsUrl, dedupeNews, isRelevantNews, newsSnippet, stripPublisherSuffix } from "@/lib/news-relevance";
import { categorizeNews, isPodiatrySourceName, NEWS_SOURCES, newsSourceLabel, type NewsSource } from "@/lib/news-sources";
import { parseFeed, type FeedItem } from "@/lib/rss";
import { adapterFor } from "@/server/integrations";

export type NewsState = { error?: string; ok?: string } | undefined;

const PER_FEED = 30;
/** Ältere Meldungen (v. a. aus Google-News-Suchen) werden nicht übernommen. */
const MAX_AGE_MS = 365 * 24 * 3600 * 1000;

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "PodoHero-News/0.1 (+https://podocrm.invalid)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error("Feed zu groß");
  return parseFeed(text).filter((i) => /^https?:\/\//.test(i.url)).slice(0, PER_FEED);
}

/**
 * Entfernt bereits gespeicherte Meldungen, die den Podologie-Relevanzfilter nicht bestehen
 * (z. B. allgemeine Ärzteblatt-/G-BA-Meldungen aus früheren Versionen). Idempotent; läuft bei jedem Abruf mit.
 * News sind öffentliche, mandantenübergreifende Daten (kein Organisationsbezug).
 */
async function pruneIrrelevantNews(): Promise<number> {
  const rows = await db.select({ id: newsItems.id, source: newsItems.source, title: newsItems.title, summary: newsItems.summary }).from(newsItems);
  const drop = rows.filter((r) => !isRelevantNews(`${r.title} ${r.summary ?? ""}`, isPodiatrySourceName(r.source))).map((r) => r.id);
  for (let i = 0; i < drop.length; i += 500) await db.delete(newsItems).where(inArray(newsItems.id, drop.slice(i, i + 500)));
  return drop.length;
}

/** Lädt alle Feeds, behält nur podologisch relevante Meldungen, entfernt Dubletten, fasst neue zusammen (LLM bzw. Mock) und ordnet Kategorien zu. Öffentliche Daten – keine Patientendaten. */
export async function refreshNewsAction(): Promise<NewsState> {
  const auth = await requireAuth();
  const errors: string[] = [];
  const perSource = await Promise.all(
    NEWS_SOURCES.map(async (source) => {
      try {
        return (await fetchFeed(source.url)).map((item) => ({ source, item }));
      } catch (e) {
        errors.push(`${source.id}: ${e instanceof Error ? e.message : String(e)}${source.verified ? "" : " (Feed-URL ungeprüft)"}`);
        return [];
      }
    }),
  );
  // Reihenfolge von NEWS_SOURCES bleibt erhalten → Fachquellen gewinnen bei Dubletten.
  const loaded = perSource.flat();
  const now = Date.now();
  const collected: { source: NewsSource; item: FeedItem; url: string; title: string; publisher?: string }[] = dedupeNews(
    loaded
      .filter(({ item }) => !item.publishedAt || now - new Date(item.publishedAt).getTime() <= MAX_AGE_MS)
      .filter(({ source, item }) => isRelevantNews(`${item.title} ${item.text}`, source.podiatrySpecific))
      .map(({ source, item }) => ({ source, item, url: cleanNewsUrl(item.url), title: item.title, publisher: item.publisher })),
  );
  const removed = await pruneIrrelevantNews();
  if (loaded.length === 0) return { error: `Keine Meldungen geladen. ${errors.join("; ")}` };

  const existingRows = collected.length
    ? await db.select({ url: newsItems.url }).from(newsItems).where(inArray(newsItems.url, collected.map((c) => c.url)))
    : [];
  const existing = new Set(existingRows.map((r) => r.url));
  const fresh = collected.filter((c) => !existing.has(c.url));

  let summaries = new Map<string, string>();
  if (fresh.length) {
    const snippets = new Map(fresh.map((f) => [f.url, newsSnippet(f.item.text, f.item.title)]));
    try {
      const llm = await adapterFor(auth.organization.id, "llm");
      const res = await llm.summarizeNews(fresh.filter((f) => snippets.get(f.url)).map((f) => ({ title: f.item.title, url: f.url, text: snippets.get(f.url) ?? "" })));
      summaries = new Map(res.map((r) => [r.url, r.summary]));
    } catch (e) {
      errors.push(`Zusammenfassung: ${e instanceof Error ? e.message : String(e)} – Anrisstext verwendet`);
    }
    await db
      .insert(newsItems)
      .values(
        fresh.map(({ source, item, url }) => ({
          source: newsSourceLabel(source, item.publisher),
          title: stripPublisherSuffix(item.title, item.publisher).slice(0, 500),
          url,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          // Nur kurzer Anriss bzw. Zusammenfassung – kein Volltext.
          summary: (summaries.get(url) || snippets.get(url) || "").slice(0, 400) || null,
          category: categorizeNews(`${item.title} ${item.text}`, source.defaultCategory),
          sponsored: source.sponsored ?? false,
        })),
      )
      .onConflictDoNothing({ target: newsItems.url });
  }
  await audit({
    organizationId: auth.organization.id,
    userId: auth.user.id,
    action: "news.refresh",
    meta: { loaded: loaded.length, relevant: collected.length, added: fresh.length, removed, errors: errors.length },
  });
  revalidatePath("/news");
  return { ok: `${fresh.length} neue Podologie-Meldungen.${removed ? ` ${removed} nicht relevante entfernt.` : ""}${errors.length ? ` Hinweise: ${errors.join("; ")}` : ""}` };
}
