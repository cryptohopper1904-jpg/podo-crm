/** PodoHero-Marke: Fußabdruck (Sohle + 5 Zehen) mit Superhelden-Cape. Quelle: public/brand/podohero-mark.svg */
const SOLE =
  "M22 23.5C25.8 23.8 31.7 24.9 35.9 27C40.1 29.1 44.6 32 47 35.9C49.4 39.8 50.6 45.3 50.3 50.6C50 55.9 47.7 61.7 45.3 67.6C42.9 73.5 38.9 81.2 35.9 86.1C32.9 91 30.2 94.6 27 97C23.8 99.4 20.2 100.5 16.8 100.5C13.4 100.5 8.9 99.3 6.5 97.3C4.1 95.3 2.6 92 2.4 88.8C2.2 85.6 3.6 81.5 5.3 77.9C7 74.3 11 70.2 12.6 67C14.2 63.8 15 61.6 14.7 58.8C14.4 56 12.2 52.9 10.9 50C9.6 47.1 7.4 44.4 6.8 41.2C6.2 38 6 33.6 7.1 30.9C8.2 28.2 10.7 26.2 13.2 25C15.7 23.8 18.2 23.2 22 23.5Z";
const CAPE =
  "M53.5 41.7C54.9 41.4 59.3 43.8 62.3 46.5C65.3 49.3 68.4 54.3 71.7 58.2C75 62.1 78 67 82.3 70C86.6 73 97.6 75.9 97.6 75.9C97.6 75.9 94.9 81.7 92.9 83.5C90.9 85.3 88.3 86.6 85.8 87C83.3 87.4 80.2 85.8 77.9 85.8C75.7 85.8 74 86.1 72.3 87C70.6 87.9 69.8 89.9 67.9 91.4C66 92.9 63.1 95.5 60.9 95.8C58.7 96.1 57 94.1 54.7 93.2C52.4 92.3 50.1 90.8 47 90.6C43.9 90.4 35.9 92 35.9 92C35.9 92 42.2 81.8 44.7 76.4C47.2 71 49.3 64.4 50.9 59.7C52.5 55.1 53.7 51.5 54.1 48.5C54.5 45.5 52.1 42 53.5 41.7Z";
const FOLDS = [
  "M53.5 47.6C53.5 47.6 59.6 50.4 62.3 53.5C65 56.6 69.4 66.4 69.4 66.4C69.4 66.4 63.9 59.5 61.2 56.4C58.6 53.3 53.5 47.6 53.5 47.6Z",
  "M62.3 66.4C62.3 66.4 67 74.9 70 78.2C73 81.5 80 86.1 80 86.1C80 86.1 71.2 82.1 68.2 78.8C65.3 75.5 62.3 66.4 62.3 66.4Z",
  "M50 74.1C50 74.1 51.4 82.1 52.3 85.3C53.2 88.5 55.3 93.5 55.3 93.5C55.3 93.5 51.5 89.9 50.6 86.7C49.7 83.5 50 74.1 50 74.1Z",
];
/** [cx, cy, rx, ry, rotation] */
const TOES: [number, number, number, number, number][] = [
  [13.2, 11.2, 7.3, 9.7, -8],
  [28.5, 13.5, 4.4, 6.5, 8],
  [40, 17.6, 3.8, 5.3, 15],
  [48.8, 24.1, 3.2, 4.4, 25],
  [54.7, 32.3, 2.9, 3.8, 30],
];

export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-2 -1 104 104" aria-hidden className="shrink-0">
      <g className="fill-primary">
        <path d={SOLE} />
        {TOES.map(([cx, cy, rx, ry, r]) => (
          <ellipse key={cx} cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${r} ${cx} ${cy})`} />
        ))}
      </g>
      <path className="fill-accent" d={CAPE} />
      <g fill="#000" fillOpacity={0.14}>
        {FOLDS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      <span className="font-display text-xl font-bold tracking-tight">
        Podo<span className="text-primary">Hero</span>
      </span>
    </span>
  );
}
