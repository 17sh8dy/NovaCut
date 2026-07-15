import type { CSSProperties } from 'react';

interface SpinnerProps {
  size?: number;
  className?: string;
}

/** A calm ring spinner (transform-only). Preferred over icon spinners for loading states. */
export function Spinner({ size = 18, className = '' }: SpinnerProps) {
  return (
    <span
      className={`oc-spinner ${className}`.trim()}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** A shimmering placeholder block for content that is still loading. */
export function Skeleton({ width = '100%', height = 12, radius, className = '', style }: SkeletonProps) {
  return (
    <span
      className={`oc-skeleton ${className}`.trim()}
      style={{ display: 'block', width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}
