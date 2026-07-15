import type { ElementType, ReactNode } from 'react';

interface TextFxProps {
  children: ReactNode;
  as?: ElementType;
  className?: string;
}

/**
 * GradientText (React Bits "Gradient Text") — clips a slowly flowing accent gradient to the
 * text. Reserved for hero-scale headings; the flow stops under reduced motion, leaving a
 * static gradient.
 */
export function GradientText({ children, as: Tag = 'span', className = '' }: TextFxProps) {
  return <Tag className={`oc-gradient-text ${className}`.trim()}>{children}</Tag>;
}

/**
 * ShinyText (React Bits "Shiny Text") — a soft highlight sweeps across muted text on a long,
 * calm loop. Good for taglines and subtle "new" labels.
 */
export function ShinyText({ children, as: Tag = 'span', className = '' }: TextFxProps) {
  return <Tag className={`oc-shiny-text ${className}`.trim()}>{children}</Tag>;
}
