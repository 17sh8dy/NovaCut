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
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, Gamepad2, Scissors, Sparkles } from 'lucide-react';
import './nova-switcher.css';

interface NovaProduct {
  id: string;
  label: string;
  tagline: string;
  icon: LucideIcon;
  /**
   * None of these has a confirmed public domain yet. TODO: confirm the real URL for each before
   * this ships — a wrong guess here sends someone to an unregistered domain, not somewhere
   * unsafe, but it should be fixed before launch. `null` (Nova Games) means there is genuinely
   * nothing to link to yet, not just an unconfirmed one — that row renders disabled instead.
   */
  url: string | null;
}

const PRODUCTS: NovaProduct[] = [
  { id: 'nova-cut', label: 'Nova Cut', tagline: 'Create and edit', icon: Scissors, url: 'https://novacut.app' },
  { id: 'replay-gg', label: 'Replay.GG', tagline: 'Record and clip gameplay', icon: Gamepad2, url: 'https://replay.gg' },
  { id: 'atlas', label: 'Atlas', tagline: 'Your desktop assistant', icon: Sparkles, url: 'https://atlas.app' },
  { id: 'nova-games', label: 'Nova Games', tagline: 'Coming soon', icon: Gamepad2, url: null },
];

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
  const [open, setOpen] = useState(false);
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
        {PRODUCTS.map((p) => {
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
          if (!p.url) {
            return (
              <span key={p.id} className="oc-nova-switcher__item oc-nova-switcher__item--soon" role="menuitem" aria-disabled="true">
                {body}
                <span className="oc-nova-switcher__badge">Soon</span>
              </span>
            );
          }
          return (
            <a key={p.id} className="oc-nova-switcher__item" role="menuitem" href={p.url} target="_blank" rel="noreferrer">
              {body}
            </a>
          );
        })}
      </div>
    </div>
  );
}
