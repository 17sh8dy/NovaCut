/**
 * @opencut/photo — the still-image document domain.
 *
 * Sits beside @opencut/core in the layering, depending only on it. Core must never import
 * this: dependencies point downward only.
 *
 * Import from here, never from deep paths, so internal layout can change.
 */

// Model
export * from './model/ids.js';
export * from './model/blend.js';
export * from './model/paint.js';
export * from './model/shapes.js';
export * from './model/text.js';
export * from './model/geometry.js';
export * from './model/types.js';
export * from './model/tree.js';
export * from './model/factory.js';
export * from './model/presets.js';

// Commands
export * from './commands/mutations.js';
export * from './commands/photoCommands.js';
export * from './commands/vectorCommands.js';

// IO
export * from './io/serializer.js';
