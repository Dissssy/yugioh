import type { ReactNode } from 'react';

/** A short centered message that stands in for a page: errors, empty states and one-step screens. */
export function Notice({
  title,
  children,
  action,
  tone,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'error';
}) {
  return (
    <section className={`notice box${tone ? ` ${tone}` : ''}`}>
      <h1>{title}</h1>
      {children && <div className="notice-body">{children}</div>}
      {action && <div className="notice-action">{action}</div>}
    </section>
  );
}

export function Loading() {
  return (
    <p className="loading" role="status">
      <span className="dot" /> Loading…
    </p>
  );
}
