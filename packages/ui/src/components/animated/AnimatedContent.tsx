import type { CSSProperties, ElementType, ReactNode } from 'react';

type Direction = 'up' | 'down' | 'left' | 'right' | 'scale';

interface AnimatedContentProps {
  children: ReactNode;
  /** Enter direction. Defaults to a gentle rise ('up'). */
  direction?: Direction;
  /** Travel distance in px for directional reveals. */
  distance?: number;
  /** Stagger delay in ms — sequence sibling reveals by passing increasing values. */
  delay?: number;
  /** Element to render. Defaults to a div. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
}

/**
 * Reveal-on-mount wrapper (React Bits "Animated Content").
 *
 * A one-shot fade + slide/scale played by CSS the moment the element mounts. Purely
 * `transform`/`opacity` so it's free to run; the app-wide reduced-motion gate collapses it
 * to an instant appearance. Use `delay` to stagger a group into a graceful cascade.
 */
export function AnimatedContent({
  children,
  direction = 'up',
  distance = 16,
  delay = 0,
  as: Tag = 'div',
  className = '',
  style,
}: AnimatedContentProps) {
  return (
    <Tag
      className={`oc-reveal ${className}`.trim()}
      data-dir={direction}
      style={
        {
          '--oc-reveal-dist': `${distance}px`,
          '--oc-reveal-delay': `${delay}ms`,
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </Tag>
  );
}
