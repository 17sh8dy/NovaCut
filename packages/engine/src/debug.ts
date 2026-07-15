/**
 * Debug tracing for the media pipeline. TEMPORARY — used to diagnose the black-preview /
 * silent-audio bug. Every message is prefixed `[oc:<cat>]` so the Electron main process can
 * forward just these lines to the terminal (see apps/desktop/electron/main.ts).
 *
 * Toggle with `window.__OC_DEBUG = false` at runtime, or flip DEBUG below.
 */

// Opt-in: tracing is OFF by default so its per-frame logging costs nothing during normal
// use. Enable at runtime in the devtools console with `window.__OC_DEBUG = true`.
function on(): boolean {
  const w = globalThis as unknown as { __OC_DEBUG?: boolean };
  return w.__OC_DEBUG === true;
}

function safeJson(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Emit ONE self-contained string per call. Electron's `console-message` event (which the
 * main process forwards to the terminal) collapses object args to `[object Object]`, so we
 * serialize here to keep the detail.
 */
function emit(cat: string, args: unknown[]): void {
  console.log(`[oc:${cat}] ${args.map(safeJson).join(' ')}`);
}

/** Log immediately. */
export function dlog(cat: string, ...args: unknown[]): void {
  if (on()) emit(cat, args);
}

const lastAt: Record<string, number> = {};

/**
 * Log at most once per `ms` for a given `key`. `produce` is only called when it will log,
 * so per-frame hot paths don't pay for string building when throttled out.
 */
export function dthrottle(key: string, ms: number, cat: string, produce: () => unknown[]): void {
  if (!on()) return;
  const now = performance.now();
  const prev = lastAt[key];
  if (prev !== undefined && now - prev < ms) return;
  lastAt[key] = now;
  emit(cat, produce());
}
