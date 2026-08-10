import type { ElementType, ReactNode } from 'react';

interface TextFxProps {
  children: ReactNode;
  as?: ElementType;
  className?: string;
}

/**
 * BrandText — the "Open Cut" wordmark, clipped to the brand gradient.
 *
 * It reads from --brand-gradient rather than the accent on purpose: the accent is a user
 * preference and the mark is not, so someone running an orange accent still sees the wordmark in
 * Deep Navy → Blue → Cyan. The gradient is static; a wordmark that animates forever is a logo
 * that never settles.
 *
 * Reserved for the wordmark. Gradient-filled body text is decoration, not hierarchy — which is
 * why the old ShinyText (a highlight sweeping across a tagline on a six-second loop) is gone
 * rather than restyled.
 */
export function BrandText({ children, as: Tag = 'span', className = '' }: TextFxProps) {
  return <Tag className={`oc-brand-text ${className}`.trim()}>{children}</Tag>;
}
