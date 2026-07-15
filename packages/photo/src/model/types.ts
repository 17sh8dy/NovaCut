/**
 * The photo domain model.
 *
 * A PhotoDocument is what a Sequence is to video, with time removed: a fixed-size canvas and
 * a bottom-to-top stack of layers, each a still with its own effect chain. Removing time is
 * the entire simplification — no ticks, no keyframes, no playhead, no trim, no speed.
 *
 * Two deliberate choices about what this model does NOT do:
 *
 *   • It declares only what the renderer actually honors. Core learned this the hard way:
 *     Clip.blendMode, Transform.crop and Transform.anchorX/Y are all declared, defaulted and
 *     then ignored by the compositor, so the model promises capabilities the product doesn't
 *     have. Layer transform, crop and blend modes land here WITH their renderer support, not
 *     before.
 *   • It stores no pixels. Layers reference a MediaAsset by id, exactly as Clip.mediaId does;
 *     decoded bitmaps live outside the document in the engine's FrameSourcePool. History
 *     retains up to 200 whole document states, which is cheap for plain JSON and ruinous for
 *     anything holding image buffers.
 */

import type { EffectInstance, MediaAsset, MediaId } from '@opencut/core';
import type { LayerId, PhotoDocumentId } from './ids.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

export type LayerKind = 'image';

/**
 * One entry in the layer stack.
 *
 * `effects` is core's EffectInstance verbatim — not a photo-specific variant. That is what
 * makes the two products share one filter rack: `instantiateEffect()` builds these, the
 * compositor's ping-pong chain consumes them, and every filter added for video shows up here
 * for free. The cost is that each param carries a `keyframes: []` a still will never fill;
 * `sample()` returns the static value when that array is empty, so it stays inert.
 */
export interface Layer {
  id: LayerId;
  kind: LayerKind;
  name: string;
  /** The still this layer draws. Absent while a layer is being created. */
  mediaId?: MediaId;
  visible: boolean;
  /** Locked layers are skipped by hit-testing and selection in the UI. */
  locked: boolean;
  /** 0..1. A plain number, not an AnimatedValue — a still has no time to animate over. */
  opacity: number;
  effects: EffectInstance[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export interface PhotoDocument {
  /** Bumped when the on-disk schema changes; migrations key off this. */
  schemaVersion: number;
  id: PhotoDocumentId;
  name: string;
  createdAt: number;
  modifiedAt: number;
  /** Canvas size in pixels. Set from the first imported image so it renders 1:1. */
  width: number;
  height: number;
  /** Background behind all layers, as hex. */
  background: string;
  /** Ordered bottom-to-top; the last layer is the topmost, matching core's Track convention. */
  layers: Layer[];
  /** Imported stills. Metadata only — the bytes stay on disk, resolved via the bridge. */
  media: MediaAsset[];
}

/**
 * Current on-disk schema version. Increment + add a migration when PhotoDocument changes.
 * Independent of core's SCHEMA_VERSION: the two formats version on their own timelines.
 */
export const PHOTO_SCHEMA_VERSION = 1;
