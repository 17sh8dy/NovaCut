import { useRef, useState, type ReactNode } from 'react';

interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
}

/** Lightweight hover tooltip. Positions itself under the trigger via fixed coords. */
export function Tooltip({ label, shortcut, children }: TooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>();

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

  return (
    <div style={{ display: 'contents' }} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && (
        <div className="oc-tooltip" style={{ left: pos.x, top: pos.y, transform: 'translateX(-50%)' }}>
          {label}
          {shortcut && <kbd>{shortcut}</kbd>}
        </div>
      )}
    </div>
  );
}
