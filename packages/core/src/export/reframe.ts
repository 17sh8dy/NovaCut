import type { Sequence } from '../model/types.js';

/**
 * How a clip of one shape is placed in an output frame of another.
 *
 *   fit      whole picture visible, bars where the shapes differ (the project's own behaviour)
 *   fill     picture covers the frame, the overflow is cropped
 *   stretch  picture is forced to the frame, no bars and no crop, so it distorts
 *
 * "Custom" is not a mode: it is the ordinary per-clip Scale/Position controls, which keep working
 * on top of whichever mode is chosen.
 */
export type ReframeMode = 'fit' | 'fill' | 'stretch';

/** What a render needs to know about the project canvas the clips were authored against. */
export interface FrameInfo {
  mode: ReframeMode;
  baseWidth: number;
  baseHeight: number;
}

/** A sequence being rendered into an output frame that is not its own canvas. */
export type FramedSequence = Sequence & { frame?: FrameInfo };

/**
 * The sequence to RENDER for an output frame — a copy, never a mutation.
 *
 * Switching the export shape must not touch the project (the canvas, clip positions and text sizes
 * are what the user authored), so the new frame lives only on this throwaway object. When the
 * target has the project's aspect ratio nothing needs reframing — ffmpeg just scales — so the
 * original object comes back untouched.
 */
export function frameSequence(
  seq: Sequence,
  target: { width: number; height: number },
  mode: ReframeMode,
): FramedSequence {
  const sameShape = Math.abs(target.width / target.height - seq.width / seq.height) < 0.01;
  if (sameShape) return seq;
  return {
    ...seq,
    width: target.width,
    height: target.height,
    frame: { mode, baseWidth: seq.width, baseHeight: seq.height },
  };
}

/**
 * How much to scale pixel-sized content (text) so it keeps the same share of the frame.
 * The smaller of the two ratios, so a title can shrink to fit a narrower frame but never grow
 * past the edge of one.
 */
export function frameScale(seq: FramedSequence): number {
  const f = seq.frame;
  return f ? Math.min(seq.width / f.baseWidth, seq.height / f.baseHeight) : 1;
}
