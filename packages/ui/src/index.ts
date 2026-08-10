/**
 * @opencut/ui — public API.
 *
 * The React front end: design system, panels, and the app store. The host app creates a
 * store with its PlatformBridge and renders <EditorApp store={store} />.
 */

export { EditorApp } from './EditorApp.js';
export { createAppStore, type AppStore } from './state/store.js';
export {
  applyTheme, loadPreferences, resolveTheme,
  type ThemePreference, type ResolvedTheme,
} from './state/preferences.js';
export { StoreProvider, useStore, useAppStore } from './state/context.js';
export * from './components/primitives/index.js';
export * from './components/animated/index.js';
