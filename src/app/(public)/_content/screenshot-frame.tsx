import Image from "next/image";
import { cx } from "@/components/ui";
import type { Screenshot } from "./screenshots";

/**
 * Screenshot im Geräterahmen (Browserfenster / iPad / Smartphone). Hell- und Dunkel-Variante werden
 * per CSS umgeschaltet (data-theme); das ausgeblendete Bild lädt dank loading="lazy" nicht mit.
 */
export function ScreenshotFrame({
  shot,
  sizes,
  eager = false,
  className,
  showCaption = true,
}: {
  shot: Screenshot;
  sizes: string;
  eager?: boolean;
  className?: string;
  showCaption?: boolean;
}) {
  const loading = eager ? ("eager" as const) : ("lazy" as const);
  const img = (src: string, extra?: string) => (
    <Image
      src={src}
      alt={shot.alt}
      width={shot.width}
      height={shot.height}
      sizes={sizes}
      loading={loading}
      fetchPriority={eager ? "high" : undefined}
      className={cx("block h-auto w-full", extra)}
    />
  );
  const frame =
    shot.device === "desktop"
      ? "rounded-xl border border-border-strong/60 bg-surface shadow-[0_18px_48px_-24px_rgb(15_42_46/0.45)]"
      : shot.device === "ipad"
        ? "rounded-[22px] border-[7px] border-[#10272b] bg-[#10272b] shadow-[0_18px_48px_-24px_rgb(15_42_46/0.5)] dark:border-[#2a4549]"
        : "mx-auto max-w-[260px] rounded-[30px] border-[7px] border-[#10272b] bg-[#10272b] shadow-[0_18px_48px_-24px_rgb(15_42_46/0.5)] dark:border-[#2a4549]";
  return (
    <figure className={cx("min-w-0", className)}>
      <div className={cx("overflow-hidden", frame)}>
        {shot.device === "desktop" ? (
          <div aria-hidden className="flex h-6 items-center gap-1.5 border-b border-border bg-surface-2 px-3">
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
          </div>
        ) : null}
        <div className={shot.device === "desktop" ? "" : "overflow-hidden rounded-[15px]"}>
          {shot.darkSrc ? (
            <>
              {img(shot.src, "dark:hidden")}
              {img(shot.darkSrc, "hidden dark:block")}
            </>
          ) : (
            img(shot.src)
          )}
        </div>
      </div>
      {showCaption ? <figcaption className="mt-3 text-sm text-muted">{shot.caption}</figcaption> : null}
    </figure>
  );
}

/** Nur das Bild (ohne Rahmen), hell/dunkel umschaltend – z. B. für Karten. decorative: leeres alt (Text steht daneben, z. B. im Link). */
export function ShotImage({ shot, sizes, className, decorative = false }: { shot: Screenshot; sizes: string; className?: string; decorative?: boolean }) {
  const img = (src: string, extra?: string) => (
    <Image src={src} alt={decorative ? "" : shot.alt} width={shot.width} height={shot.height} sizes={sizes} loading="lazy" className={cx("block h-auto w-full", className, extra)} />
  );
  return shot.darkSrc ? (
    <>
      {img(shot.src, "dark:hidden")}
      {img(shot.darkSrc, "hidden dark:block")}
    </>
  ) : (
    img(shot.src)
  );
}

/** Einheitlicher Hinweis unter Galerien */
export function DemoDataNote({ className }: { className?: string }) {
  return (
    <p className={cx("text-xs text-muted", className)}>
      Echte Bildschirmfotos aus PodoHero mit erfundenen Demodaten (Namen, Adressen und Befunde sind ausgedacht).
    </p>
  );
}
