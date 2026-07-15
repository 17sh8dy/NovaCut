/**
 * Motion primitives — a lightweight, dependency-free "React Bits" layer for Open Cut.
 *
 * Small, composable, GPU-friendly components used to add tasteful polish (reveals, gradient
 * text, spotlights, loaders) without pulling in an animation runtime. Styles live in
 * ./animated.css and every effect is silenced by the app's reduced-motion gates.
 */
export { AnimatedContent } from './AnimatedContent.js';
export { GradientText, ShinyText } from './Text.js';
export { SpotlightCard } from './SpotlightCard.js';
export { Spinner, Skeleton } from './Loaders.js';
