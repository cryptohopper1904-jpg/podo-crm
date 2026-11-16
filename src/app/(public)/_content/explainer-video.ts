/**
 * Erklärvideo der Startseite (public/video). Alle Dateien vom eigenen Server, keine Video-Plattform.
 * Dateinamen mit Versionsanhang (-v2): bei einer neuen Fassung neue Namen vergeben, dann darf der Browser lange cachen
 * (Cache-Control für /video/* in next.config.ts).
 */
export const EXPLAINER_VIDEO = {
  title: "PodoHero im Überblick – Erklärvideo",
  description:
    "Rundgang durch PodoHero, die Praxissoftware für Podologie: Tagesübersicht, Patientensuche, Kalender, Doku am iPad mit Fußschema, Online-Terminanfrage, Rechnung und Kasse (Kassen-TSE derzeit im Testmodus), Auswertung und Web-App – gezeigt mit erfundenen Demo-Daten, Abläufe gekürzt.",
  /** 16:9 für breite Bildschirme */
  wide: {
    src: "/video/podohero-erklaervideo-v2.mp4",
    poster: { webp: "/video/podohero-erklaervideo-poster-v2.webp", jpg: "/video/podohero-erklaervideo-poster-v2.jpg" },
    width: 1920,
    height: 1080,
  },
  /** 9:16 für schmale Bildschirme (Auswahl beim Klick, siehe NARROW_QUERY) */
  tall: {
    src: "/video/podohero-erklaervideo-9x16-v2.mp4",
    poster: { webp: "/video/podohero-erklaervideo-9x16-poster-v2.webp", jpg: "/video/podohero-erklaervideo-9x16-poster-v2.jpg" },
    width: 1080,
    height: 1920,
  },
  captions: "/video/podohero-erklaervideo-v2.de.vtt",
  /** Länge 2:36 */
  durationIso: "PT2M36S",
  durationLabel: "2:36",
  uploadDate: "2026-11-16",
} as const;

/** Schmale Viewports: entspricht Tailwind „max-sm“ (unter 40rem = 640px), damit Poster-Zuschnitt und Videodatei zusammenpassen. */
export const NARROW_QUERY = "(max-width: 639.98px)";

/** Hinweis unter dem Video (wörtlich, rechtlich abgestimmt – nicht ohne Prüfung ändern). */
export const EXPLAINER_VIDEO_NOTE =
  "Lädt erst beim Klick auf Abspielen · direkt von unserem Server, ohne eingebundene Fremddienste und ohne Tracking · Untertitel verfügbar · Sprecherstimme KI-generiert · Demo-Daten, Abläufe gekürzt · Kassen-TSE derzeit im Testmodus";
