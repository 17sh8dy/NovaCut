import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
}

/** Keeps the tooltip's own edge this far from the viewport edge, in pixels. */
const MARGIN = 8;

/** Lightweight hover tooltip. Positions itself under the trigger via fixed coords. */
export function Tooltip({ label, shortcut, children }: TooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>();
  const tooltipRef = useRef<HTMLDivElement>(null);

  const show = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.bottom + 8;
    timer.current = window.setTimeout(() => setPos({ x, y }), 400);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };

  /*
   * The box is centred on its trigger (`translateX(-50%)` below), which is fine anywhere except
   * near a window edge — a toolbar button in the top-left corner (Save, New, Open, ...) centred
   * a tooltip whose left half then rendered off-screen at a negative x, invisible. This clamps
   * the centre point so the rendered box's own edges stay MARGIN px inside the viewport, run in
   * useLayoutEffect so it lands before the browser paints — no visible jump from the naive
   * position to the clamped one.
   */
  useLayoutEffect(() => {
    if (!pos || !tooltipRef.current) return;
    const el = tooltipRef.current;
    const halfWidth = el.offsetWidth / 2;
    const clampedX = Math.min(Math.max(pos.x, MARGIN + halfWidth), window.innerWidth - MARGIN - halfWidth);
    const clampedY = Math.min(pos.y, window.innerHeight - MARGIN - el.offsetHeight);
    el.style.left = `${clampedX}px`;
    el.style.top = `${clampedY}px`;
  }, [pos]);

  return (
    <div style={{ display: 'contents' }} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && (
        <div ref={tooltipRef} className="oc-tooltip" style={{ left: pos.x, top: pos.y, transform: 'translateX(-50%)' }}>
          {label}
          {shortcut && <kbd>{shortcut}</kbd>}
        </div>
      )}
    </div>
  );
}
