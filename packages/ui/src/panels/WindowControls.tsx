/**
 * Minimise / maximise / close, drawn by the app.
 *
 * The desktop window hides its native title bar so the workspace can start at the very top, and
 * Electron's `titleBarOverlay` — the API that would let the OS paint real controls onto our bar
 * — cannot be used (with it set, the window never fires `ready-to-show` and so never appears).
 * These buttons are the replacement, and they are shaped to match Windows' own: 46×full-height
 * hit targets, no gaps between them, and a red close button, because a control that LOOKS like a
 * window control but behaves half a pixel differently is worse than an honestly custom one.
 *
 * Hidden on macOS, where the traffic lights are real and merely inset over our bar, and on any
 * host that doesn't implement `windowAction` (the web build).
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../state/context.js';

export function WindowControls() {
  const store = useAppStore();
  const bridge = store.getState().bridge;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => bridge.onWindowState?.((s) => setMaximized(s.maximized)), [bridge]);

  if (!bridge.windowAction) return null;
  // macOS draws its own traffic lights over the left of the bar; a second set would be absurd.
  if (typeof document !== 'undefined' && document.documentElement.dataset['os'] === 'mac') return null;

  return (
    <div className="oc-wincontrols">
      <button
        className="oc-wincontrols__btn"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => bridge.windowAction?.('minimize')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        className="oc-wincontrols__btn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => bridge.windowAction?.('toggleMaximize')}
      >
        {maximized ? (
          // Restore: the front square with the one behind it peeking out, as Windows draws it.
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button
        className="oc-wincontrols__btn oc-wincontrols__btn--close"
        aria-label="Close"
        title="Close"
        onClick={() => bridge.windowAction?.('close')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}
