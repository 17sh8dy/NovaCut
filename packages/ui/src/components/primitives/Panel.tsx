import type { ReactNode } from 'react';

interface PanelProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled, rounded container used for every dockable panel. */
export function Panel({ title, actions, children, className = '' }: PanelProps) {
  return (
    <div className={`oc-panel ${className}`}>
      {(title || actions) && (
        <div className="oc-panel__header">
          {title && <span className="oc-panel__title">{title}</span>}
          {actions && <div style={{ display: 'flex', gap: 4 }}>{actions}</div>}
        </div>
      )}
      <div className="oc-panel__body">{children}</div>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}

export function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="oc-segmented">
      {options.map((o) => (
        <button key={o.value} data-active={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="oc-empty">
      {icon}
      <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', fontWeight: 500 }}>{title}</div>
      {hint && <div style={{ fontSize: 'var(--text-sm)' }}>{hint}</div>}
    </div>
  );
}
