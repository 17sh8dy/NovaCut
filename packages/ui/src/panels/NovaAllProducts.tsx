/**
 * The full-screen "all Nova products" view — opened by the "View all" row at the foot of
 * NovaSwitcher's dropdown. The dropdown stays the quick way to jump straight to a sibling
 * product; this is the slower, better-looking one for actually browsing the family, laid out as
 * a card grid instead of a short menu.
 *
 * Styled after Online Earth's All Tools launcher (read directly from that repo's
 * all-tools/all-tools.css and allToolsLauncher.js before building this) but built from this
 * app's own tokens — `.oc-backdrop`'s scrim (dialog.css) and the entrance keyframes
 * (theme/global.css) already used by every other modal here — rather than Online Earth's own
 * hand-rolled glass values, so it never drifts from a theme or accent change and never
 * introduces a second glass language next to the one this app already has.
 */

import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import './nova-all-products.css';

export interface NovaAllProduct {
  id: string;
  label: string;
  tagline: string;
  icon: LucideIcon;
  url: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  current: string;
  currentLabel?: string;
  products: NovaAllProduct[];
  mark: React.ReactNode;
}

export function NovaAllProducts({ open, onClose, current, currentLabel, products, mark }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Matches the dropdown menu's own courtesy: the thing you'd reach for next has focus
    // the moment the view is up, so Escape (or Tab) works without a mouse.
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="oc-nova-all__backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="oc-nova-all-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button ref={closeRef} type="button" className="oc-nova-all__close" aria-label="Close" onClick={onClose}>
        <X size={18} />
      </button>
      <div className="oc-nova-all">
        <p className="oc-nova-all__eyebrow">
          <span className="oc-nova-all__mark">{mark}</span>
          <span>Nova</span>
        </p>
        <h2 className="oc-nova-all__title" id="oc-nova-all-title">
          All products
        </h2>
        <p className="oc-nova-all__subtitle">Everything Nova makes, in one place.</p>
        <div className="oc-nova-all__grid">
          {products.map((p, i) => {
            const Icon = p.icon;
            const isCurrent = p.id === current;
            const label = isCurrent && currentLabel ? currentLabel : p.label;
            const body = (
              <>
                <span className="oc-nova-all__icon">
                  <Icon size={20} />
                </span>
                <span className="oc-nova-all__label">{label}</span>
                <span className="oc-nova-all__tagline">{isCurrent ? "You're here" : p.tagline}</span>
              </>
            );
            const style = { animationDelay: `${i * 40}ms` };

            if (isCurrent) {
              return (
                <span key={p.id} className="oc-nova-all__card oc-nova-all__card--current" style={style}>
                  {body}
                </span>
              );
            }
            if (!p.url) {
              return (
                <span key={p.id} className="oc-nova-all__card oc-nova-all__card--soon" style={style}>
                  {body}
                  <span className="oc-nova-all__badge">Soon</span>
                </span>
              );
            }
            return (
              <a key={p.id} className="oc-nova-all__card" href={p.url} target="_blank" rel="noreferrer" style={style}>
                {body}
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
