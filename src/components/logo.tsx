export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-[10px] bg-primary text-on-primary"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M8 20c-2 0-3-2-3-5s1-7 4-9 5 0 5 3-1 5-1 7 1 4-1 4H8z" />
        <circle cx="17" cy="6" r="1.5" />
        <circle cx="19.5" cy="9.5" r="1.2" />
      </svg>
    </span>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className="font-display text-xl font-bold">PodoHero</span>
    </span>
  );
}
