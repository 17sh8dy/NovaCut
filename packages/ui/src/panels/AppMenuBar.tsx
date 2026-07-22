/**
 * The in-app menu bar (File · Edit · View · Help).
 *
 * The desktop window is frameless so the app can draw its own title bar, and a frameless window
 * gets no native menu bar on Windows or Linux. These buttons ask the host to pop its REAL menus
 * instead of reimplementing them in React — which matters more than it looks: the native menu
 * owns the accelerator labels, the roles (cut/copy/paste against the focused input), keyboard
 * navigation and the platform's own styling, none of which a div can imitate correctly.
 *
 * On a host with no `popupMenu` (the web build) it renders nothing, so the layout above it never
 * has to know which platform it is on.
 */

import { useRef } from 'react';
import type { WindowMenuId } from '@opencut/core';
import { useAppStore } from '../state/context.js';

const MENUS: { id: WindowMenuId; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
];

export function AppMenuBar() {
  const store = useAppStore();
  const bridge = store.getState().bridge;
  const barRef = useRef<HTMLDivElement>(null);

  if (!bridge.popupMenu) return null;

  return (
    <div className="oc-menubar" ref={barRef}>
      {MENUS.map(({ id, label }) => (
        <button
          key={id}
          className="oc-menubar__item"
          /*
           * click, NOT pointerdown — even though a menu bar conventionally opens on press.
           *
           * The menu that opens here is a real native popup, and on Windows a native popup
           * tracks the mouse: opening it while the button is still down means the release that
           * follows lands on the just-opened menu and dismisses it immediately. Opening on
           * release costs a few milliseconds of perceived latency and is the difference between
           * a menu that appears and one that does not.
           */
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            // Anchor to the button's bottom-left, in CSS pixels relative to the window — which
            // is the coordinate space Menu.popup expects.
            bridge.popupMenu?.(id, r.left, r.bottom);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
