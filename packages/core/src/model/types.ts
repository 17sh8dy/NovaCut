/**
 * The Open Cut domain model.
 *
 * These types describe *what a project is* — a serializable, UI-agnostic data structure.
 * They are the single source of truth shared by the timeline, compositor, exporter, and
 * (eventually) the web/mobile clients. Everything here is plain data: no methods, no
 * classes, so a project is trivially JSON-serializable and diffable.
 */

import type {
  ClipId,
  EffectInstanceId,
  KeyframeId,
  MediaId,
  ProjectId,
  SequenceId,
  TrackId,
} from './ids.js';
import type { Ticks } from './time.js';

// ─────────────────────────────────────────────────────────────────────────────
// Media
// ─────────────────────────────────────────────────────────────────────────────

export type MediaKind = 'video' | 'audio' | 'image' | 'gif';

/** A file imported into the project's media library. Immutable source metadata. */
export interface MediaAsset {
  id: MediaId;
  kind: MediaKind;
  name: string;
  /** Absolute path (desktop) or opaque handle key (web). Resolved via PlatformBridge. */
  src: string;
  /** Source duration in ticks. Images have a nominal duration; 0 means "still". */
  duration: Ticks;
  width: number;
  height: number;
  /** Native frame rate of the source, if it has one. */
  fps?: number;
  hasAudio: boolean;
  /** Data-URL or cached path for the library thumbnail. Filled in asynchronously. */
  thumbnail?: string;
  /** File size in bytes, for the library and inspector. */
  fileSize?: number;
  importedAt: number;
  favorite?: boolean;
  /** User-assigned bin/folder for organizing the library. */
  bin?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyframes & animatable values
// ─────────────────────────────────────────────────────────────────────────────

export type InterpolationKind = 'linear' | 'hold' | 'bezier' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface Keyframe {
  id: KeyframeId;
  /** Time relative to the clip's start, in ticks. */
  time: Ticks;
  value: number;
  interpolation: InterpolationKind;
  /** Bezier control handles (normalized) when interpolation === 'bezier'. */
  bezier?: { inX: number; inY: number; outX: number; outY: number };
}

/**
 * A value that is either constant or animated by keyframes. The compositor samples this
 * at any playhead position. This one shape powers transform animation, effect params,
 * volume automation, opacity ramps — everything animatable.
 */
export interface AnimatedValue {
  static: number;
  keyframes: Keyframe[];
}

export const constant = (value: number): AnimatedValue => ({ static: value, keyframes: [] });

// ─────────────────────────────────────────────────────────────────────────────
// Transform (spatial) — applies to every visual clip
// ─────────────────────────────────────────────────────────────────────────────

export interface Transform {
  /** Position of the clip's anchor, in sequence pixels, relative to sequence center. */
  x: AnimatedValue;
  y: AnimatedValue;
  scaleX: AnimatedValue; // 1 = 100%
  scaleY: AnimatedValue;
  rotation: AnimatedValue; // degrees
  opacity: AnimatedValue; // 0..1
  anchorX: AnimatedValue; // 0..1 within the clip
  anchorY: AnimatedValue;
  /** Rectangular crop, in normalized 0..1 of the source. */
  crop: { top: number; right: number; bottom: number; left: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────────────────────

/** A live effect on a clip. Its `params` keys are validated against the registry def. */
export interface EffectInstance {
  id: EffectInstanceId;
  /** Registry key, e.g. 'blur', 'chromatic-aberration'. */
  type: string;
  enabled: boolean;
  /** Each param may be constant or keyframed. Keys come from the effect definition. */
  params: Record<string, AnimatedValue>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/**
 * An animation applied to a text clip (typewriter, word fade-in, …). Resolved against the
 * text-animation registry by `type`; `params` keys come from that definition. Optional and
 * additive — a clip with no `animation` renders exactly as before.
 */
export interface TextAnimation {
  type: string;
  params: Record<string, number>;
}

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  letterSpacing: number;
  lineHeight: number;
  color: string;
  /** Optional two-stop gradient fill; overrides `color` when present. */
  gradient?: { from: string; to: string; angle: number };
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; x: number; y: number };
  glow?: { color: string; radius: number; intensity: number };
  background?: { color: string; padding: number; radius: number };
  /** Optional reveal/motion animation driven by the text-animation registry. */
  animation?: TextAnimation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioProperties {
  volume: AnimatedValue; // 0..1 (linear gain), automatable
  muted: boolean;
  fadeIn: Ticks;
  fadeOut: Ticks;
  /** Playback pitch in semitones. Independent of speed when the engine supports it. */
  pitch: number;
  /** Parametric EQ bands. Empty = flat. */
  eq: { frequency: number; gain: number; q: number }[];
  normalize: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Speed
// ─────────────────────────────────────────────────────────────────────────────

export interface SpeedProperties {
  /** Constant rate when `curve` is empty. 1 = realtime, negative = reverse. */
  rate: number;
  reverse: boolean;
  /** Optional speed ramp: keyframes of rate over clip time. */
  curve: Keyframe[];
  /** Keep pitch constant when changing speed. */
  preservePitch: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clips
// ─────────────────────────────────────────────────────────────────────────────

export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'shape' | 'adjustment';

/**
 * A clip is a placement of media (or generated content) on a track.
 *
 *   sourceIn/sourceOut  — the trimmed window *into the media* (source time)
 *   start               — where the clip's head sits on the timeline (sequence time)
 *   duration            — timeline length after speed is applied
 *
 * Keeping source-trim and timeline-position separate is what makes non-destructive
 * ripple/roll/slip/slide edits possible.
 */
export interface Clip {
  id: ClipId;
  kind: ClipKind;
  name: string;
  /** Media source. Absent for generated clips (text/shape/adjustment). */
  mediaId?: MediaId;
  start: Ticks;
  duration: Ticks;
  sourceIn: Ticks;
  sourceOut: Ticks;
  enabled: boolean;
  /** Editor-only color label for organization. */
  label?: ClipLabel;

  transform: Transform;
  effects: EffectInstance[];
  speed: SpeedProperties;

  /** Present on visual clips that carry audio, and on audio clips. */
  audio?: AudioProperties;
  /** Present only when kind === 'text'. */
  text?: TextStyle;
  /** Present only when kind === 'shape'. */
  shape?: { type: 'rectangle' | 'ellipse' | 'triangle' | 'line'; color: string; cornerRadius: number };
  /** Blend mode for compositing over lower tracks. */
  blendMode: BlendMode;
}

export type ClipLabel =
  | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'difference' | 'exclusion';

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/** A transition anchored between two adjacent clips on the same track. */
export interface Transition {
  id: string;
  type: string; // registry key: 'cross-dissolve', 'zoom', 'glitch', ...
  /** The two clips it joins (fromClip ends, toClip begins). */
  fromClipId: ClipId;
  toClipId: ClipId;
  duration: Ticks;
  params: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracks
// ─────────────────────────────────────────────────────────────────────────────

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: TrackId;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  transitions: Transition[];
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Solo isolates this track for preview. */
  solo: boolean;
  height: number; // UI row height in px
  color?: ClipLabel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequence (a timeline) & captions
// ─────────────────────────────────────────────────────────────────────────────

export interface Caption {
  id: string;
  start: Ticks;
  end: Ticks;
  text: string;
  /** BCP-47 language tag, e.g. 'en', 'es'. Enables multi-language subtitle tracks. */
  language: string;
  style?: Partial<TextStyle>;
}

export interface Sequence {
  id: SequenceId;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Background color behind all tracks. */
  background: string;
  sampleRate: number;
  /** Tracks are ordered bottom-to-top for video (last = topmost visually). */
  tracks: Track[];
  captions: Caption[];
  /** Cached total duration in ticks; recomputed on edit. */
  duration: Ticks;
  playhead: Ticks;
  /** In/out marks for range export and looped playback. */
  inPoint?: Ticks;
  outPoint?: Ticks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectSettings {
  autosaveIntervalMs: number;
  snapEnabled: boolean;
  rippleEnabled: boolean;
  theme: 'dark' | 'light' | 'midnight';
}

export interface Project {
  /** Bumped when the on-disk schema changes; migrations key off this. */
  schemaVersion: number;
  id: ProjectId;
  name: string;
  createdAt: number;
  modifiedAt: number;
  media: MediaAsset[];
  sequences: Sequence[];
  activeSequenceId: SequenceId;
  settings: ProjectSettings;
}

/** Current on-disk schema version. Increment + add a migration when Project changes. */
export const SCHEMA_VERSION = 1;
