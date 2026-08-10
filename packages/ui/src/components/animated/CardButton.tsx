import type { ButtonHTMLAttributes } from 'react';

/**
 * A clickable card.
 *
 * This exists for one unglamorous reason: a card you can click must be a real `<button>`, or it
 * is invisible to the keyboard and to a screen reader. It replaces the old SpotlightCard, which
 * did the same job while also painting a radial glow that tracked the pointer — decoration that
 * pulled the eye toward the chrome and away from the thumbnails the cards exist to show.
 *
 * The hover and focus feedback lives entirely in CSS on the card's own class (a one-pixel lift
 * and a border that takes the accent), so this component contributes no styling of its own
 * beyond being focusable.
 */
export function CardButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  );
}
