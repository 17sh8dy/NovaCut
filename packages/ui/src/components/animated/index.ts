/**
 * Motion primitives — a lightweight, dependency-free polish layer for Open Cut.
 *
 * Small, composable, GPU-friendly components covering the motion the interface actually needs:
 * reveal-on-mount, the wordmark, and loading states. Styles live in ./animated.css, which
 * documents why the decorative effects that used to live here (spotlights, shine sweeps,
 * aurora, pulsing halos) were removed rather than retuned.
 */
export { AnimatedContent } from './AnimatedContent.js';
export { BorderGlow } from './BorderGlow.js';
export { BrandText } from './Text.js';
export { CardButton } from './CardButton.js';
export { Spinner, Skeleton } from './Loaders.js';
