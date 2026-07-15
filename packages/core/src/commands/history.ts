/**
 * Command + history.
 *
 * A Command is a pure, named transformation of a document. The History runs commands,
 * keeps a bounded undo/redo stack of resulting states (cheap thanks to structural sharing
 * in mutations.ts), and can coalesce rapid same-kind edits (e.g. dragging a slider) into
 * a single undo step.
 *
 * Because commands are pure and serializable-in-intent, this same mechanism is the future
 * seam for collaboration (broadcast commands) and for autosave (persist on new state).
 *
 * Both are generic over the document type, defaulting to Project so video code reads as
 * `Command` / `History` unchanged. Nothing here inspects the document: the sole test is the
 * `next === prev` identity check in dispatch. That is what lets a still-image document
 * (see @opencut/photo) reuse undo/redo rather than fork it — the machinery was never
 * video-specific, only its type annotations were.
 *
 * Two invariants any document type must honor:
 *
 *   1. No-op commands MUST return the identical reference. `next === prev` is the only
 *      guard against pushing junk undo steps, so mutation helpers must return the input
 *      untouched when nothing changed rather than always spreading a fresh object.
 *   2. Keep bulk binary data OUT of the document. The stack retains up to `limit` whole
 *      states; that is cheap for plain JSON with structural sharing, and ruinous if states
 *      embed pixel buffers. Reference heavy data by id and store it out of band — the way
 *      Clip.mediaId points at a MediaAsset instead of inlining its bytes.
 */

import type { Project } from '../model/types.js';

export interface Command<TDoc = Project> {
  /** Human label shown in the Edit menu ("Undo Move Clip"). */
  label: string;
  /** Optional key; consecutive commands with the same coalesceKey merge into one step. */
  coalesceKey?: string;
  apply: (doc: TDoc) => TDoc;
}

interface Entry<TDoc> {
  label: string;
  coalesceKey?: string;
  state: TDoc;
}

export class History<TDoc = Project> {
  private stack: Entry<TDoc>[] = [];
  private index = -1;
  private readonly limit: number;
  private listeners = new Set<() => void>();

  constructor(initial: TDoc, limit = 200) {
    this.stack.push({ label: 'Open', state: initial });
    this.index = 0;
    this.limit = limit;
  }

  get current(): TDoc {
    return this.stack[this.index]!.state;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  get undoLabel(): string | undefined {
    return this.canUndo ? this.stack[this.index]!.label : undefined;
  }

  get redoLabel(): string | undefined {
    return this.canRedo ? this.stack[this.index + 1]!.label : undefined;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Run a command, pushing (or coalescing into) a new undo step. */
  dispatch(command: Command<TDoc>): TDoc {
    const prev = this.current;
    const next = command.apply(prev);
    if (next === prev) return prev; // no-op command, don't pollute history

    const top = this.stack[this.index]!;
    const canCoalesce =
      command.coalesceKey != null &&
      top.coalesceKey === command.coalesceKey &&
      this.index === this.stack.length - 1;

    if (canCoalesce) {
      // Replace the top state in place — the whole drag is one undo.
      this.stack[this.index] = { label: command.label, coalesceKey: command.coalesceKey, state: next };
    } else {
      // Truncate any redo branch, then push.
      this.stack.length = this.index + 1;
      this.stack.push({ label: command.label, coalesceKey: command.coalesceKey, state: next });
      this.index++;
      if (this.stack.length > this.limit) {
        this.stack.shift();
        this.index--;
      }
    }
    this.emit();
    return next;
  }

  /** Replace state without creating history (e.g. loading a project). Resets the stack. */
  reset(state: TDoc, label = 'Open'): void {
    this.stack = [{ label, state }];
    this.index = 0;
    this.emit();
  }

  undo(): TDoc {
    if (this.canUndo) {
      this.index--;
      this.emit();
    }
    return this.current;
  }

  redo(): TDoc {
    if (this.canRedo) {
      this.index++;
      this.emit();
    }
    return this.current;
  }
}
