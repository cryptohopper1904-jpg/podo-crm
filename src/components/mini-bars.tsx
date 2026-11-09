/**
 * Kleines Säulendiagramm als Inline-SVG (keine Chart-Bibliothek, kein JavaScript im Browser).
 * Farben über Design-Tokens (hell/dunkel). Werte stehen zusätzlich als <title> und in der aria-Beschreibung.
 */
export function MiniBars({
  values,
  labels,
  label,
  format = (n) => n.toLocaleString("de-DE"),
  height = 72,
}: {
  values: number[];
  labels: string[];
  label: string;
  format?: (n: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const w = 100 / Math.max(1, values.length);
  const desc = values.map((v, i) => `${labels[i]}: ${format(v)}`).join(", ");
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs font-medium text-muted">
        <span>{label}</span>
        <span className="font-display text-base font-semibold tabular-nums text-text">{format(values.at(-1) ?? 0)}</span>
      </figcaption>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${desc}`} className="h-16 w-full">
        {values.map((v, i) => {
          const h = v === 0 ? 1 : Math.max(2, (v / max) * (height - 2));
          return (
            <rect key={labels[i] ?? i} x={i * w + w * 0.12} y={height - h} width={w * 0.76} height={h} rx={1.5} className={i === values.length - 1 ? "fill-primary" : "fill-primary/45"}>
              <title>{`${labels[i]}: ${format(v)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-muted" aria-hidden>
        <span>{labels[0]}</span>
        <span>{labels.at(-1)}</span>
      </div>
    </figure>
  );
}
