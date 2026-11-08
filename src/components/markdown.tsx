import Link from "next/link";
import type { ReactNode } from "react";
import { type Block, type Inline, parseMarkdown } from "@/lib/markdown";

/** Rendert Markdown aus src/lib/markdown.ts als React-Elemente – kein dangerouslySetInnerHTML, React escaped alles. */
function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case "text":
        return n.value;
      case "strong":
        return <strong key={key} className="font-semibold">{renderInline(n.children, key + "-")}</strong>;
      case "em":
        return <em key={key}>{renderInline(n.children, key + "-")}</em>;
      case "code":
        return <code key={key} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9em]">{n.value}</code>;
      case "placeholder":
        return (
          <mark key={key} className="rounded bg-warn-soft px-1 font-semibold text-warn-soft-text" title="Platzhalter – vom Betreiber auszufüllen">
            {n.value}
          </mark>
        );
      case "link": {
        const cls = "font-semibold text-primary underline underline-offset-2 hover:text-primary-hover";
        if (n.href.startsWith("/") || n.href.startsWith("#"))
          return <Link key={key} href={n.href} className={cls}>{renderInline(n.children, key + "-")}</Link>;
        const external = /^https?:/i.test(n.href);
        return (
          <a key={key} href={n.href} className={cls} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {renderInline(n.children, key + "-")}
          </a>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "heading": {
        const content = renderInline(b.children);
        if (b.level === 1) return <h1 key={i} id={b.id} className="mb-4 scroll-mt-24 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{content}</h1>;
        if (b.level === 2) return <h2 key={i} id={b.id} className="mb-3 mt-10 scroll-mt-24 font-display text-2xl font-semibold">{content}</h2>;
        if (b.level === 3) return <h3 key={i} id={b.id} className="mb-2 mt-6 scroll-mt-24 text-lg font-semibold">{content}</h3>;
        return <h4 key={i} id={b.id} className="mb-2 mt-4 scroll-mt-24 font-semibold">{content}</h4>;
      }
      case "paragraph":
        return <p key={i} className="mb-4 leading-relaxed">{renderInline(b.children)}</p>;
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={i} className={`mb-4 flex flex-col gap-1.5 pl-6 leading-relaxed ${b.ordered ? "list-decimal" : "list-disc"}`}>
            {b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
          </Tag>
        );
      }
      case "quote":
        return (
          <div key={i} className="mb-6 rounded-[var(--radius-card)] border border-warn-soft-text/20 bg-warn-soft px-5 py-4 text-warn-soft-text [&_p:last-child]:mb-0">
            {renderBlocks(b.children)}
          </div>
        );
      case "table":
        return (
          <div key={i} className="mb-6 overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr>{b.head.map((c, j) => <th key={j} scope="col" className="bg-surface-2 px-4 py-2.5 font-semibold">{renderInline(c)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{r.map((c, k) => <td key={k} className="border-t border-border px-4 py-2.5 align-top">{renderInline(c)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={i} className="my-8 border-border" />;
    }
  });
}

export function Markdown({ source }: { source: string }) {
  return <div className="text-[15px] text-text">{renderBlocks(parseMarkdown(source))}</div>;
}
