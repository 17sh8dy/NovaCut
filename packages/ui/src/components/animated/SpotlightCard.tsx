import { useEffect, useRef, type ButtonHTMLAttributes, type PointerEvent } from 'react';

/**
 * SpotlightCard (React Bits "Spotlight Card") — a card that lights up with a soft radial glow
 * tracking the pointer. Renders a real <button> so it stays keyboard-focusable and clickable.
 *
 * The glow position is written to CSS custom properties inside a single rAF per move, so a
 * fast pointer coalesces into one style write per frame (no layout thrash). The effect is
 * skipped entirely when the app is in a reduced-motion state.
 */
export function SpotlightCard({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const reduced = () =>
    document.documentElement.hasAttribute('data-reduce-motion') ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el || reduced()) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      el.style.setProperty('--oc-spot-x', `${x}px`);
      el.style.setProperty('--oc-spot-y', `${y}px`);
      el.style.setProperty('--oc-spot-o', '1');
    });
  };

  const onPointerLeave = () => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    el.style.setProperty('--oc-spot-o', '0');
  };

  return (
    <button
      ref={ref}
      className={`oc-spotlight ${className}`.trim()}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      {...rest}
    >
      {children}
    </button>
  );
}
