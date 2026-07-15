/**
 * Factory helpers — the *only* sanctioned way to construct domain objects, so defaults
 * stay consistent everywhere. UI code never hand-builds a Clip; it calls these.
 */

import {
  newClipId,
  newProjectId,
  newSequenceId,
  newTrackId,
} from './ids.js';
import { seconds, type Ticks } from './time.js';
import {
  constant,
  SCHEMA_VERSION,
  type AudioProperties,
  type Clip,
  type ClipKind,
  type MediaAsset,
  type Project,
  type Sequence,
  type SpeedProperties,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transform,
} from './types.js';

export function defaultTransform(): Transform {
  return {
    x: constant(0),
    y: constant(0),
    scaleX: constant(1),
    scaleY: constant(1),
    rotation: constant(0),
    opacity: constant(1),
    anchorX: constant(0.5),
    anchorY: constant(0.5),
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

export function defaultAudio(): AudioProperties {
  return {
    volume: constant(1),
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    pitch: 0,
    eq: [],
    normalize: false,
  };
}

export function defaultSpeed(): SpeedProperties {
  return { rate: 1, reverse: false, curve: [], preservePitch: true };
}

export function defaultTextStyle(content = 'New Text'): TextStyle {
  return {
    content,
    fontFamily: 'Inter',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    underline: false,
    align: 'center',
    letterSpacing: 0,
    lineHeight: 1.2,
    color: '#ffffff',
    shadow: { color: '#000000aa', blur: 12, x: 0, y: 4 },
  };
}

export function createTrack(kind: TrackKind, name: string): Track {
  return {
    id: newTrackId(),
    kind,
    name,
    clips: [],
    transitions: [],
    muted: false,
    hidden: false,
    locked: false,
    solo: false,
    height: kind === 'video' ? 72 : 56,
  };
}

/** Build a clip from an imported media asset, at a given start on the timeline. */
export function createClipFromMedia(media: MediaAsset, start: Ticks): Clip {
  const kind: ClipKind = media.kind === 'gif' ? 'video' : (media.kind as ClipKind);
  // Images/GIFs get a default on-screen length; time-based media use their full source.
  const duration = media.duration > 0 ? media.duration : seconds(5);
  const isVisual = media.kind !== 'audio';
  return {
    id: newClipId(),
    kind: media.kind === 'audio' ? 'audio' : kind,
    name: media.name,
    mediaId: media.id,
    start,
    duration,
    sourceIn: 0,
    sourceOut: media.duration > 0 ? media.duration : duration,
    enabled: true,
    transform: defaultTransform(),
    effects: [],
    speed: defaultSpeed(),
    audio: media.hasAudio || media.kind === 'audio' ? defaultAudio() : undefined,
    blendMode: 'normal',
    ...(isVisual ? {} : {}),
  };
}

export function createTextClip(start: Ticks, content = 'New Text', duration = seconds(4)): Clip {
  return {
    id: newClipId(),
    kind: 'text',
    name: content.slice(0, 24) || 'Text',
    start,
    duration,
    sourceIn: 0,
    sourceOut: duration,
    enabled: true,
    transform: defaultTransform(),
    effects: [],
    speed: defaultSpeed(),
    text: defaultTextStyle(content),
    blendMode: 'normal',
  };
}

export interface SequencePreset {
  name?: string;
  width: number;
  height: number;
  fps: number;
  sampleRate?: number;
}

export const SEQUENCE_PRESETS: Record<string, SequencePreset> = {
  '1080p30': { name: 'HD 1080p · 30fps', width: 1920, height: 1080, fps: 30 },
  '1080p60': { name: 'HD 1080p · 60fps', width: 1920, height: 1080, fps: 60 },
  '4k30': { name: 'UHD 4K · 30fps', width: 3840, height: 2160, fps: 30 },
  vertical: { name: 'Vertical 9:16 · 30fps', width: 1080, height: 1920, fps: 30 },
  square: { name: 'Square 1:1 · 30fps', width: 1080, height: 1080, fps: 30 },
};

export function createSequence(preset: SequencePreset): Sequence {
  const video1 = createTrack('video', 'V1');
  const audio1 = createTrack('audio', 'A1');
  return {
    id: newSequenceId(),
    name: preset.name ?? 'Sequence',
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    background: '#000000',
    sampleRate: preset.sampleRate ?? 48000,
    tracks: [video1, audio1],
    captions: [],
    duration: 0,
    playhead: 0,
  };
}

export function createProject(name = 'Untitled Project', preset = SEQUENCE_PRESETS['1080p30']!): Project {
  const sequence = createSequence(preset);
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newProjectId(),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    sequences: [sequence],
    activeSequenceId: sequence.id,
    settings: {
      autosaveIntervalMs: 60000,
      snapEnabled: true,
      rippleEnabled: false,
      theme: 'dark',
    },
  };
}
