/**
 * HistoryPanel — the undo stack, as a list you can jump around in.
 *
 * Undo/redo answers "take that back". A history panel answers a different and more common
 * question: "what did I do, and can I get back to how it looked four steps ago without
 * counting Ctrl+Z presses?" That is worth a panel.
 *
 * It reads History's internal stack through a narrow structural cast rather than through a new
 * public API. That is a deliberate, contained trade: History's job is undo/redo, and widening
 * its interface so one panel can draw a list would make every future change to the stack a
 * breaking change for a UI concern. The cast is one function, it is total (missing fields
 * degrade to an empty list), and it is the only place in the app that knows the shape.
 */

import { History as HistoryIcon, RotateCcw } from 'lucide-react';
import type { History } from '@opencut/core';
import type { PhotoDocument } from '@opencut/photo';
import { EmptyState } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';

interface StackView {
  entries: { label: string }[];
  index: number;
}

/**
 * Read the stack, or report an empty one.
 *
 * Total by construction: anything unexpected produces `{ entries: [], index: -1 }`, which the
 * panel renders as its empty state. A history panel that throws would be worse than no history
 * panel.
 */
function readStack(history: History<PhotoDocument>): StackView {
  const raw = history as unknown as { stack?: { label: string }[]; index?: number };
  if (!Array.isArray(raw.stack) || typeof raw.index !== 'number') return { entries: [], index: -1 };
  return { entries: raw.stack.map((e) => ({ label: e.label })), index: raw.index };
}

export function HistoryPanel() {
  const store = usePhotoStore();
  // Subscribing to the version counter is what makes this re-render: the stack lives inside
  // History, which React cannot observe, and the cursor can move without the document changing.
  usePhoto((s) => s.historyVersion);
  const history = usePhoto((s) => s.history);
  const { entries, index } = readStack(history);

  if (entries.length <= 1) {
    return (
      <div className="oc-history">
        <EmptyState icon={<HistoryIcon size={22} />} title="No history yet" hint="Every edit lands here." />
      </div>
    );
  }

  return (
    <div className="oc-history">
      {/* Newest first — the step you want is almost always a recent one. */}
      {entries.map((_, i) => i).reverse().map((i) => {
        const entry = entries[i]!;
        const isCurrent = i === index;
        const isFuture = i > index;
        return (
          <button
            key={i}
            className={`oc-hrow${isCurrent ? ' oc-hrow--current' : ''}${isFuture ? ' oc-hrow--future' : ''}`}
            onClick={() => store.getState().travel(i - index)}
            title={isFuture ? 'Redo to here' : 'Undo to here'}
          >
            <RotateCcw size={12} className="oc-hrow__icon" />
            <span className="oc-hrow__label">{entry.label}</span>
            <span className="oc-hrow__num">{i}</span>
          </button>
        );
      })}
    </div>
  );
}
