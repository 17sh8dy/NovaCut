/**
 * @opencut/core — public API.
 *
 * The platform-agnostic heart of Open Cut: domain model, command system, registries, and
 * IO contracts. Import from here, never from deep paths, so internal layout can change.
 */

// Model
export * from './model/ids.js';
export * from './model/time.js';
export * from './model/types.js';
export * from './model/factory.js';
export * from './model/textPresets.js';
export * from './model/animation.js';
export * from './model/queries.js';

// Commands
export * from './commands/history.js';
export * from './commands/mutations.js';
export * from './commands/timelineCommands.js';

// Effects / transitions
export * from './effects/registry.js';
export * from './effects/definitions.js';

// IO / platform
export * from './io/platform.js';
export * from './io/serializer.js';

// Export
export * from './export/presets.js';
