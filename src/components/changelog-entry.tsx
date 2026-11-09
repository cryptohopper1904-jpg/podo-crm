import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ChangelogEntry, ChangelogTag } from "@/content/changelog";
import { formatChangelogDate, tagLabel } from "@/lib/changelog";
import { cx } from "./ui";

const tagCls: Record<ChangelogTag, string> = {
  neu: "bg-primary-soft text-primary-soft-text",
  verbessert: "bg-info-soft text-info-soft-text",
  behoben: "bg-warn-soft text-warn-soft-text",
};

/** Ein Neuigkeiten-Eintrag (Popup und Seite /neuigkeiten). */
export function ChangelogEntryView({ entry, headingLevel = 3, onNavigate }: { entry: ChangelogEntry; headingLevel?: 2 | 3; onNavigate?: () => void }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="flex flex-col gap-3">
      <div>
        <p className="text-sm text-muted">
          <time dateTime={entry.date}>{formatChangelogDate(entry.date)}</time>
        </p>
        <H className="font-display text-lg font-semibold leading-snug">{entry.title}</H>
      </div>
      <ul className="flex flex-col gap-2.5">
        {entry.items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 text-[15px] leading-relaxed">
            <span className={cx("mt-0.5 inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", tagCls[item.tag])}>{tagLabel(item.tag)}</span>
            <span className="min-w-0">
              {item.text}
              {item.href ? (
                <>
                  {" "}
                  <Link href={item.href} onClick={onNavigate} className="inline-flex items-center font-semibold whitespace-nowrap text-primary underline-offset-2 hover:underline">
                    Ansehen<ChevronRight size={15} aria-hidden />
                  </Link>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}
