"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Play } from "lucide-react";
import { EXPLAINER_VIDEO, NARROW_QUERY } from "./explainer-video";

/**
 * Click-to-load: Vor dem Klick zeigt die Seite nur das Vorschaubild – kein <video>, keine Anfrage auf .mp4/.vtt
 * (geprüft in e2e/startseite-video.spec.ts). Erst der Klick setzt das Video ein und startet es.
 * Schmale Viewports (NARROW_QUERY) bekommen die 9:16-Fassung; der Rahmen hat dort schon vorher 9:16 (Hochformat-Poster),
 * breite Viewports 16:9 – so springt das Layout beim Umschalten nicht.
 * Untertitel-Spur ohne „default“: Zuschalten über die Steuerelemente des Players.
 */
export function ExplainerVideoPlayer() {
  const [variant, setVariant] = useState<"wide" | "tall" | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const v = EXPLAINER_VIDEO;

  function start() {
    const tall = window.matchMedia(NARROW_QUERY).matches;
    // synchron rendern, damit play() noch innerhalb der Klick-Geste läuft (iOS Safari)
    flushSync(() => setVariant(tall ? "tall" : "wide"));
    const el = videoRef.current;
    if (!el) return;
    el.focus();
    el.play().catch(() => {
      /* Autoplay blockiert: Steuerelemente sind sichtbar, Abspielen per Klick möglich */
    });
  }

  // 9:16 unter 640px (Höhe begrenzt, Breite aus dem Seitenverhältnis), darüber 16:9 über die volle Breite
  const box =
    "relative mx-auto block h-[min(70svh,36rem)] max-w-full aspect-[9/16] overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-2 shadow-[0_18px_48px_-24px_rgb(15_42_46/0.45)] sm:h-auto sm:w-full sm:aspect-video";

  if (variant) {
    const file = v[variant];
    return (
      <div className={box}>
        <video
          ref={videoRef}
          className="absolute inset-0 size-full bg-black object-contain"
          controls
          playsInline
          preload="auto"
          poster={file.poster.webp}
          width={file.width}
          height={file.height}
          aria-label={v.title}
        >
          <source src={file.src} type="video/mp4" />
          <track kind="subtitles" srcLang="de" label="Deutsch" src={v.captions} />
          Ihr Browser kann dieses Video nicht abspielen.
        </video>
      </div>
    );
  }

  return (
    <button type="button" onClick={start} aria-label={`Erklärvideo abspielen (${v.durationLabel}, mit Untertiteln)`} className={`${box} group cursor-pointer`}>
      <picture>
        <source media={NARROW_QUERY} type="image/webp" srcSet={v.tall.poster.webp} width={v.tall.width} height={v.tall.height} />
        <source media={NARROW_QUERY} type="image/jpeg" srcSet={v.tall.poster.jpg} width={v.tall.width} height={v.tall.height} />
        <source type="image/webp" srcSet={v.wide.poster.webp} />
        {/* Art-Direction (9:16/16:9) per <picture>; Poster liegen fertig optimiert in public/video (ohne /_next/image) */}
        <img
          src={v.wide.poster.jpg}
          alt=""
          width={v.wide.width}
          height={v.wide.height}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      </picture>
      {/* Hochformat-Poster: Logo in der Mitte → Abspielknopf darunter; 16:9 mittig */}
      <span aria-hidden className="absolute inset-0 bg-[rgb(15_42_46/0.08)] transition-colors group-hover:bg-[rgb(15_42_46/0.16)]">
        <span className="absolute left-1/2 top-[72%] inline-flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-on-primary shadow-[0_10px_30px_-10px_rgb(15_42_46/0.7)] transition-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100 sm:top-1/2 sm:size-20">
          <Play size={30} className="ml-1 fill-current" />
        </span>
      </span>
      <span aria-hidden className="absolute bottom-3 left-3 rounded-full bg-bg/90 px-3 py-1 text-sm font-semibold text-text backdrop-blur">
        Erklärvideo · {v.durationLabel} · Untertitel
      </span>
    </button>
  );
}
