import { useCallback, useRef, useState, type ReactNode } from 'react';

interface ResizablePanelsProps {
  direction: 'horizontal' | 'vertical';
  /** Initial sizes as flex-grow ratios; must match children count. */
  initial: number[];
  /** Minimum pixel size per pane. */
  min?: number[];
  children: ReactNode[];
  className?: string;
}

/**
 * A splitter that lays out N children along one axis with draggable dividers between them.
 * Sizes are kept as flex ratios so the layout stays responsive when the window resizes.
 * This is the building block for the whole dockable editor workspace.
 */
export function ResizablePanels({ direction, initial, min = [], children, className = '' }: ResizablePanelsProps) {
  const [sizes, setSizes] = useState<number[]>(initial);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);
  const horizontal = direction === 'horizontal';

  const onMove = useCallback(
    (e: PointerEvent) => {
      const idx = dragIndex.current;
      const container = containerRef.current;
      if (idx === null || !container) return;
      const rect = container.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      const pos = horizontal ? e.clientX - rect.left : e.clientY - rect.top;

      setSizes((prev) => {
        const sum = prev.reduce((a, b) => a + b, 0);
        // Pixel offset of the divider = cumulative size of panes before it.
        let before = 0;
        for (let i = 0; i <= idx; i++) before += (prev[i]! / sum) * total;
        const delta = pos - before;
        const next = [...prev];
        const unit = sum / total; // ratio per pixel
        const minA = (min[idx] ?? 80) * unit;
        const minB = (min[idx + 1] ?? 80) * unit;
        const a = next[idx]! + delta * unit;
        const b = next[idx + 1]! - delta * unit;
        if (a < minA || b < minB) return prev;
        next[idx] = a;
        next[idx + 1] = b;
        return next;
      });
    },
    [horizontal, min],
  );

  const endDrag = useCallback(() => {
    dragIndex.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    document.body.style.cursor = '';
  }, [onMove]);

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    dragIndex.current = i;
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', width: '100%', height: '100%', minHeight: 0 }}
    >
      {children.map((child, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div style={{ flex: `${sizes[i] ?? 1} 1 0`, minWidth: 0, minHeight: 0, display: 'flex' }}>{child}</div>
          {i < children.length - 1 && (
            <div
              onPointerDown={startDrag(i)}
              className="oc-resizer"
              style={{
                flex: '0 0 auto',
                width: horizontal ? 6 : '100%',
                height: horizontal ? '100%' : 6,
                cursor: horizontal ? 'col-resize' : 'row-resize',
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
