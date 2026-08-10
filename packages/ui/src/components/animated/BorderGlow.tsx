import type { HTMLAttributes } from 'react';

/**
 * BorderGlow — an accent light that travels around an element's EDGE on hover and focus.
 *
 * ## Why this is allowed where SpotlightCard was not
 *
 * The design system's rule is that surfaces stay neutral and the accent is a signal, not a
 * decoration; SpotlightCard was deleted for painting a radial wash that tracked the pointer
 * *across the card's face*, pulling the eye onto the chrome and away from the content the card
 * exists to show. This deliberately stays on the 1px border and never touches the interior — it
 * is the same information the existing `:hover` border-colour change already carries, drawn with
 * more life. Nothing moves until you point at it, so a still screenshot of the app is unchanged.
 *
 * ## How it is drawn
 *
 * A conic gradient on a pseudo-element, masked down to the border ring by compositing a
 * content-box mask against a full-size one (`mask-composite: exclude`). The angle is a
 * registered custom property (`@property --oc-glow-angle`) — that registration is what makes an
 * angle *animatable* at all; without it the browser treats the value as an unanimatable string
 * and the ring sits frozen.
 *
 * Under `prefers-reduced-motion` the rotation stops and a static accent ring is shown instead,
 * so the affordance survives without the movement.
 *
 * Usable two ways: wrap something in `<BorderGlow>`, or put `oc-borderglow` directly on an
 * element that is already a button — which is what the Home workspace cards do, since wrapping a
 * `<button>` in a div would just add a layer between the card and its own hover state.
 */
export function BorderGlow({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`oc-borderglow ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
