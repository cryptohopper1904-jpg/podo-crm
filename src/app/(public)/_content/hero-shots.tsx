import { ScreenshotFrame } from "./screenshot-frame";
import { PORTAL_PHONE, SHOTS } from "./screenshots";

/**
 * Hero der Startseite: echte Screenshots (Demodaten) – Tagesüberblick am Desktop, Fußschema am iPad, Online-Buchung am Smartphone.
 * Auf kleinen Bildschirmen nur der Desktop-Screenshot (weniger Daten).
 */
export function HeroShots() {
  return (
    <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <ScreenshotFrame shot={SHOTS.heute} sizes="(min-width: 1024px) 560px, (min-width: 640px) 576px, 100vw" eager showCaption={false} />
      <div className="absolute -bottom-10 -left-4 hidden w-[44%] sm:block lg:-left-10">
        <ScreenshotFrame shot={SHOTS.fussschema} sizes="260px" showCaption={false} />
      </div>
      <div className="absolute -bottom-14 -right-3 hidden w-[24%] sm:block lg:-right-6">
        <ScreenshotFrame shot={PORTAL_PHONE} sizes="150px" showCaption={false} className="[&>div]:max-w-none" />
      </div>
      <p className="sr-only">Bildschirmfotos aus PodoHero mit erfundenen Demodaten.</p>
    </div>
  );
}
