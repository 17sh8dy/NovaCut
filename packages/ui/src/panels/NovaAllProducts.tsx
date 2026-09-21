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
import { X } from 'lucide-react';
import type { NovaProduct } from './novaProducts.js';
import './nova-all-products.css';

export type NovaAllProduct = NovaProduct;

interface Props {
  open: boolean;
  onClose: () => void;
  current: string;
  currentLabel?: string;
  products: NovaAllProduct[];
  /** Websites, shown in their own section under the apps. */
  sites?: NovaAllProduct[];
  mark: React.ReactNode;
  /** Open a product: an app is launched, a website opens in the browser. */
  onOpen: (product: NovaAllProduct) => void;
}

export function NovaAllProducts({ open, onClose, current, currentLabel, products, sites = [], mark, onOpen }: Props) {
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

  const renderCard = (p: NovaAllProduct, i: number) => {
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
    if (p.kind === 'soon') {
      return (
        <span key={p.id} className="oc-nova-all__card oc-nova-all__card--soon" style={style}>
          {body}
          <span className="oc-nova-all__badge">Soon</span>
        </span>
      );
    }
    return (
      <button key={p.id} type="button" className="oc-nova-all__card" style={style} onClick={() => onOpen(p)}>
        {body}
      </button>
    );
  };

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
        <p className="oc-nova-all__section">Apps</p>
        <div className="oc-nova-all__grid">{products.map(renderCard)}</div>
        {sites.length > 0 && (
          <>
            <p className="oc-nova-all__section">Websites</p>
            <div className="oc-nova-all__grid">{sites.map(renderCard)}</div>
          </>
        )}
      </div>
    </div>
  );
}
