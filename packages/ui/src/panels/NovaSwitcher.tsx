/**
 * The Nova product switcher — a small trigger next to the Home chrome that opens a menu of
 * sibling Nova products. Ported from the reference implementation in NovaCutSite
 * (src/components.mjs `novaSwitcher()` + data/nova.js) — see that repo for the design rationale
 * and keep this list in sync with it and with the other repos' copies by hand.
 *
 * The trigger is labelled "Product Switcher" rather than "Nova Cut" or "Nova" — it announces
 * what it does, not which product you're already looking at (the Home hero's own wordmark
 * already does that).
 *
 * Left out on purpose: Nova, Nova.Help and NovaLegal each already have their own way to switch
 * between the products they front, so they're neither getting this switcher nor listed as a
 * destination in it. Online Earth was never asked for and isn't here either.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, Globe } from 'lucide-react';
import { useAppStore } from '../state/context.js';
import { NovaAllProducts } from './NovaAllProducts';
import { NOVA_APPS, NOVA_SITES, openNovaProduct, type NovaProduct } from './novaProducts.js';
import './nova-switcher.css';

/** The Nova sparkle mark — identical to assets/favicon.svg in the Nova repo. */
function NovaMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="oc-nova-switcher__mark-svg">
      <rect width="24" height="24" rx="5.5" fill="#0E1120" />
      <path
        fill="#7C5CFF"
        d="M12 3.1c.52 5.46 3.95 8.89 9.41 9.41-5.46.52-8.89 3.95-9.41 9.41-.52-5.46-3.95-8.89-9.41-9.41C8.05 11.99 11.48 8.56 12 3.1Z"
      />
    </svg>
  );
}

export function NovaSwitcher({ current }: { current: string }) {
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);

  /** Apps are launched (or their download page opened); websites open in the default browser. */
  const launch = (p: NovaProduct) => {
    setOpen(false);
    setAllOpen(false);
    const { bridge, notify } = store.getState();
    void openNovaProduct(bridge, notify, p);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="oc-nova-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="oc-nova-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="oc-nova-switcher__mark">
          <NovaMark />
        </span>
        <span className="oc-nova-switcher__trigger-label">Product Switcher</span>
        <ChevronDown size={12} className="oc-nova-switcher__chevron" />
      </button>
      <div className="oc-nova-switcher__menu" role="menu" data-open={open}>
        <p className="oc-nova-switcher__eyebrow">Nova</p>
        {NOVA_APPS.map((p) => {
          const Icon = p.icon;
          const isCurrent = p.id === current;
          const body = (
            <>
              <span className="oc-nova-switcher__icon">
                <Icon size={16} />
              </span>
              <span className="oc-nova-switcher__text">
                <span className="oc-nova-switcher__label">{p.label}</span>
                <span className="oc-nova-switcher__tagline">{isCurrent ? "You're here" : p.tagline}</span>
              </span>
            </>
          );

          if (isCurrent) {
            return (
              <span key={p.id} className="oc-nova-switcher__item oc-nova-switcher__item--current" role="menuitem" aria-current="true">
                {body}
              </span>
            );
          }
          if (p.kind === 'soon') {
            return (
              <span key={p.id} className="oc-nova-switcher__item oc-nova-switcher__item--soon" role="menuitem" aria-disabled="true">
                {body}
                <span className="oc-nova-switcher__badge">Soon</span>
              </span>
            );
          }
          return (
            <button
              key={p.id}
              type="button"
              className="oc-nova-switcher__item"
              role="menuitem"
              onClick={() => launch(p)}
            >
              {body}
              {p.kind === 'site' && <Globe size={13} className="oc-nova-switcher__kind" />}
            </button>
          );
        })}
        <button
          type="button"
          className="oc-nova-switcher__viewall"
          onClick={() => {
            setOpen(false);
            setAllOpen(true);
          }}
        >
          <span>View all</span>
          <ArrowRight size={13} />
        </button>
      </div>
      <NovaAllProducts
        open={allOpen}
        onClose={() => setAllOpen(false)}
        current={current}
        products={NOVA_APPS}
        sites={NOVA_SITES}
        mark={<NovaMark />}
        onOpen={launch}
      />
    </div>
  );
}
