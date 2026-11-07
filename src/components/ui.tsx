import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const cx = clsx;

type Variant = "primary" | "secondary" | "accent" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  accent: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2",
  ghost: "text-text hover:bg-surface-2",
  danger: "bg-surface text-danger border border-border hover:bg-accent-soft",
};
const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 h-11 text-[15px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(base, variants[variant], className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cx("rounded-[var(--radius-card)] bg-surface border border-border p-5", className)} {...props} />;
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="font-display text-xl font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end gap-4">
      <div className="min-w-0 flex-1">
        {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = "primary" | "accent" | "info" | "warn" | "neutral";
const tones: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary-soft-text",
  accent: "bg-accent-soft text-accent-soft-text",
  info: "bg-info-soft text-info-soft-text",
  warn: "bg-warn-soft text-warn-soft-text",
  neutral: "bg-surface-2 text-muted",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub, tone = "primary" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={cx("rounded-[var(--radius-card)] p-5", tones[tone])}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-2 font-display text-3xl font-bold tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-[13px]">{sub}</p> : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-border bg-surface px-3.5 h-11 text-[15px] text-text placeholder:text-muted focus:border-primary focus:outline-none";

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputCls, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputCls, "pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputCls, "h-auto min-h-24 py-2.5", className)} {...props} />;
}

export function Checkbox({ label, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-[15px]">
      <input type="checkbox" className="size-5 accent-[var(--primary)]" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border-strong p-8 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-left text-[15px] [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_th]:bg-surface-2 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">
      {message}
    </p>
  );
}

export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">
      {message}
    </p>
  );
}
