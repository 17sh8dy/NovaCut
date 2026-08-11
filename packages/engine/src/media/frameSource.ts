/**
 * FrameSource — wraps a decoded media element so the compositor can grab "the frame at
 * source-time T" as a texture source. One per media asset, cached and reused.
 *
 * On desktop/web the cheapest universal decoder is a hidden <video>/<img>. When we later
 * adopt WebCodecs for frame-accurate export, only this class changes — the compositor
 * asks for `getFrame(t)` and doesn't care how it's produced.
 */

import { toSeconds, type MediaAsset, type Ticks } from '@opencut/core';
import { dlog, dthrottle } from '../debug.js';

/**
 * How long a single seek may stay outstanding before the source releases itself.
 *
 * Longer than whenReady's 2s wait on purpose: this is not a pacing knob, it is the escape hatch
 * for a seek that will never complete at all. Firing it early would abandon decodes that were
 * merely slow.
 */
const SEEK_WATCHDOG_MS = 4000;

export type FrameBitmap = HTMLVideoElement | HTMLImageElement | ImageBitmap;

/**
 * A single hidden, off-screen container that all decode elements live in. Chromium will
 * not reliably decode or *present* a frame for a <video> that is detached from the DOM and
 * paused — so texImage2D(video) yields a black texture. Keeping the elements attached (but
 * invisible) guarantees they decode a displayable frame we can upload.
 */
let mediaContainer: HTMLElement | null = null;
function getMediaContainer(): HTMLElement {
  if (mediaContainer && mediaContainer.isConnected) return mediaContainer;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.appendChild(el);
  mediaContainer = el;
  return el;
}

export class FrameSource {
  readonly media: MediaAsset;
  private el: HTMLVideoElement | HTMLImageElement;
  private ready = false;
  private seeking = false;
  private pendingSeek: number | null = null;
  /** Last seek target (seconds) we requested — used to avoid re-issuing an unreachable seek. */
  private lastSeekTarget = -1;
  /** Releases a seek that never completes; see the note in seekTo. */
  private seekWatchdog: ReturnType<typeof setTimeout> | undefined;

  /** Fired when a new drawable frame becomes available (decode/seek complete). */
  private onReady: () => void;

  constructor(media: MediaAsset, resolveUrl: (src: string) => string, onReady?: () => void) {
    this.media = media;
    this.onReady = onReady ?? (() => {});
    const url = resolveUrl(media.src);
    dlog('decode', 'FrameSource create', {
      id: media.id,
      kind: media.kind,
      name: media.name,
      src: media.src,
      resolvedUrl: url,
      srcScheme: /^([a-z]+):/i.exec(media.src)?.[1] ?? '(bare path)',
    });
    if (media.kind === 'audio') {
      // Audio still needs an element for the audio graph, but produces no frame.
      const v = document.createElement('video');
      v.src = url;
      v.preload = 'auto';
      this.el = v;
    } else if (media.kind === 'image') {
      const img = new Image();
      // crossOrigin must be set BEFORE src so the fetch is a CORS request → the decoded
      // image is not tainted and can be uploaded to a WebGL texture.
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        this.ready = true;
        this.onReady();
      };
      img.src = url;
      this.el = img;
    } else {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true; // audio path is the Web Audio graph, not the element
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadedmetadata = () =>
        dlog('decode', 'video loadedmetadata', { id: media.id, w: v.videoWidth, h: v.videoHeight, dur: v.duration });
      v.onloadeddata = () => {
        this.ready = true;
        dlog('decode', 'video loadeddata (first frame decoded)', {
          id: media.id,
          readyState: v.readyState,
          w: v.videoWidth,
          h: v.videoHeight,
          currentTime: v.currentTime,
        });
        this.onReady(); // draw the first frame as soon as it decodes (fixes black preview)
      };
      v.onseeked = () => {
        this.seeking = false;
        dlog('decode', 'video seeked', { id: media.id, currentTime: v.currentTime, readyState: v.readyState });
        this.onReady(); // re-render after a scrub settles
        if (this.pendingSeek != null) {
          const t = this.pendingSeek;
          this.pendingSeek = null;
          this.seekTo(t);
        }
      };
      v.onerror = () =>
        dlog('decode', 'video ERROR', {
          id: media.id,
          code: v.error?.code,
          message: v.error?.message,
          resolvedUrl: url,
        });
      v.onstalled = () => dlog('decode', 'video stalled', { id: media.id });
      v.onwaiting = () => dlog('decode', 'video waiting (buffer underrun)', { id: media.id });
      // Real per-frame decode signal: timestamp + dimensions of each PRESENTED frame.
      const rvfc = (v as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, meta: Record<string, number>) => void) => number;
      }).requestVideoFrameCallback;
      if (rvfc) {
        const onFrame = (_now: number, meta: Record<string, number>) => {
          dthrottle(`rvfc:${media.id}`, 500, 'decode', () => [
            'video frame decoded',
            {
              id: media.id,
              mediaTime: Number(meta['mediaTime']?.toFixed?.(3)),
              presentedFrames: meta['presentedFrames'],
              w: meta['width'],
              h: meta['height'],
            },
          ]);
          rvfc.call(v, onFrame);
        };
        rvfc.call(v, onFrame);
      } else {
        dlog('decode', 'requestVideoFrameCallback UNAVAILABLE — cannot trace per-frame decode', { id: media.id });
      }
      v.src = url;
      this.el = v;
    }
    // Attach video elements to the hidden pool so Chromium actually decodes frames.
    if (this.el instanceof HTMLVideoElement) getMediaContainer().appendChild(this.el);
  }

  get element(): HTMLVideoElement | HTMLImageElement {
    return this.el;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Reconcile the element to timeline `sourceTime`.
   *
   * PLAYING: let the element play in real time and only correct large drift. Seeking every
   * frame (what scrubbing does) thrashes the decoder — on high-res/60fps clips it never holds
   * a frame, so the preview freezes and flashes black. Playing lets Chromium decode smoothly.
   *
   * PAUSED / scrubbing: seek to the exact frame.
   */
  sync(sourceTime: Ticks, playing: boolean, rate = 1): void {
    if (!(this.el instanceof HTMLVideoElement)) return;
    const v = this.el;
    // Forward playback at a positive rate: let the element play at the clip's speed. A video
    // element can't play in reverse, and rate 0 is meaningless — those fall through to the
    // per-frame seek path below (so reverse/held frames still render, just via seeking).
    if (playing && rate > 0) {
      // Match the element's speed to the clip's, or drift accumulates and the correction
      // seek below fires every frame → the stutter/flicker seen on sped-up clips.
      v.playbackRate = Math.max(0.0625, Math.min(16, rate));
      if (v.paused) {
        this.lastSeekTarget = -1; // allow a fresh correction seek after resume
        void v.play().catch(() => {});
      }
      const target = toSeconds(sourceTime);
      // Correct only meaningful drift so playback stays smooth.
      if (Number.isFinite(target) && !this.seeking && Math.abs(v.currentTime - target) > 0.5) {
        this.seeking = true;
        try {
          v.currentTime = target;
        } catch {
          this.seeking = false;
        }
      }
      return;
    }
    if (!v.paused) v.pause();
    this.seekTo(sourceTime);
  }

  /**
   * Seek a video source to a source-time position (ticks). Images ignore this.
   *
   * ── THE TARGET IS CLAMPED, AND THAT IS LOAD-BEARING ──────────────────────────────────
   *
   * A transition renders BOTH of its clips across its whole window, and that window straddles the
   * cut — so the incoming clip is asked for times before its own start, a NEGATIVE source time,
   * and the outgoing one for times past its end. Unclamped, that wedged the source permanently:
   *
   *   1. the guards below passed, so `seeking` was set and `currentTime = -0.3` assigned
   *   2. the browser clamps that to 0 — and if currentTime was already 0 nothing changed, so no
   *      `seeked` event ever fired
   *   3. `seeking` stayed true forever, and `onseeked` — the only thing that drains
   *      `pendingSeek` — never ran again
   *   4. every later seekTo hit the coalescing branch and returned without seeking, so the
   *      element froze on whatever frame it happened to hold
   *   5. every whenReady() then waited out its full timeout, once per exported frame
   *
   * Measured: one 1s cross dissolve took an 8s export from 21.6s to ~190s, and the source stayed
   * frozen for the rest of the render — invisible on solid-colour test footage, a still image on
   * anything real.
   *
   * Clamping first turns an out-of-range request into one the element can actually satisfy, which
   * the "already there" guard then recognises as a no-op and returns from WITHOUT claiming to be
   * seeking.
   */
  seekTo(sourceTime: Ticks): void {
    if (!(this.el instanceof HTMLVideoElement)) return;
    const v = this.el;
    // duration is NaN until metadata arrives; clamp what we can and leave the rest to the element.
    const limit = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const target = Math.min(Math.max(0, toSeconds(sourceTime)), limit);

    if (this.seeking) {
      // Coalesce rapid scrubs: remember only the latest requested time.
      this.pendingSeek = sourceTime;
      return;
    }
    // Guard against re-issuing the SAME seek every frame: if the target can't be reached yet
    // (data not buffered), re-seeking would cancel the in-flight seek forever → frozen/flash.
    if (Math.abs(v.currentTime - target) < 1 / 1000 || target === this.lastSeekTarget) return;
    this.lastSeekTarget = target;
    this.seeking = true;

    /*
     * Defence in depth for a seek that genuinely never completes — a corrupt file, a decoder that
     * gives up. Without it one such seek costs every remaining frame its full timeout and leaves
     * the picture frozen. This releases the source so the next frame can try again, and is longer
     * than whenReady's own timeout so it fires only when something is actually wrong.
     */
    clearTimeout(this.seekWatchdog);
    this.seekWatchdog = setTimeout(() => {
      if (!this.seeking) return;
      this.seeking = false;
      this.lastSeekTarget = -1; // allow the same target to be retried
      const pending = this.pendingSeek;
      this.pendingSeek = null;
      if (pending != null) this.seekTo(pending);
    }, SEEK_WATCHDOG_MS);

    try {
      v.currentTime = target;
    } catch {
      this.seeking = false;
      clearTimeout(this.seekWatchdog);
    }
  }

  /**
   * Resolve once this source actually has a decodable frame for the position it was last
   * asked to seek to — or when `timeoutMs` runs out.
   *
   * Export needs this. The live preview can afford to draw a stale frame and repaint when
   * `onReady` fires, but an offline render gets exactly one chance per output frame: whatever
   * is decoded when `readPixels` runs is what lands in the file. Sleeping a fixed number of
   * milliseconds and hoping is not a wait — a seek that misses the window yields
   * `readyState < 2`, `getFrame()` returns null, and the compositor writes a BLACK frame into
   * the export. Measured on a 52s 60fps clip that was 47% of the output.
   *
   * The timeout is a floor on progress, not a correctness knob: if a decode genuinely stalls
   * we would rather emit one stale frame than hang the export forever.
   */
  whenReady(timeoutMs = 2000): Promise<void> {
    if (this.el instanceof HTMLImageElement) return Promise.resolve();
    const v = this.el;
    if (!this.seeking && v.readyState >= 2) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        v.removeEventListener('seeked', check);
        v.removeEventListener('loadeddata', check);
        clearTimeout(timer);
        resolve();
      };
      // `seeking` is cleared by the onseeked property handler, which was registered in the
      // constructor and therefore runs BEFORE this listener. If that handler started a
      // coalesced pendingSeek, `seeking` is true again and we keep waiting for the next one.
      const check = (): void => {
        if (!this.seeking && v.readyState >= 2) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      v.addEventListener('seeked', check);
      v.addEventListener('loadeddata', check);
    });
  }

  /** The current drawable frame, or null if not yet decodable. */
  getFrame(): FrameBitmap | null {
    if (this.el instanceof HTMLImageElement) {
      dthrottle(`getFrame:${this.media.id}`, 500, 'decode', () => [
        'getFrame(image)',
        { id: this.media.id, ready: this.ready },
      ]);
      return this.ready ? this.el : null;
    }
    const v = this.el;
    const ok = v.readyState >= 2;
    dthrottle(`getFrame:${this.media.id}`, 500, 'decode', () => [
      'getFrame(video)',
      { id: this.media.id, readyState: v.readyState, ok, currentTime: Number(v.currentTime.toFixed(3)), w: v.videoWidth, h: v.videoHeight },
    ]);
    return ok ? v : null;
  }

  /** Native pixel dimensions, once known. */
  get dimensions(): { width: number; height: number } {
    if (this.el instanceof HTMLVideoElement) {
      return { width: this.el.videoWidth || this.media.width, height: this.el.videoHeight || this.media.height };
    }
    return {
      width: this.el.naturalWidth || this.media.width,
      height: this.el.naturalHeight || this.media.height,
    };
  }

  dispose(): void {
    // Before the element goes: a pending watchdog would otherwise fire against a dead source and
    // re-enter seekTo on it. Export disposes the whole pool in a finally, so this runs on the
    // failure path too.
    clearTimeout(this.seekWatchdog);
    if (this.el instanceof HTMLVideoElement) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    this.el.remove();
  }
}

/** Cache of FrameSources keyed by media id, so each asset decodes once. */
export class FrameSourcePool {
  private sources = new Map<string, FrameSource>();
  /** Notified whenever any source produces a new frame — used to refresh a paused preview. */
  onFrameReady: () => void = () => {};

  constructor(private resolveUrl: (src: string) => string) {}

  get(media: MediaAsset): FrameSource {
    let s = this.sources.get(media.id);
    if (!s) {
      s = new FrameSource(media, this.resolveUrl, () => this.onFrameReady());
      this.sources.set(media.id, s);
    }
    return s;
  }

  /**
   * Wait for every live source to have a decodable frame. Used by the offline exporter between
   * the seek-issuing render and the pixel-reading one.
   */
  whenAllReady(timeoutMs = 2000): Promise<void> {
    return Promise.all([...this.sources.values()].map((s) => s.whenReady(timeoutMs))).then(() => undefined);
  }

  dispose(mediaId: string): void {
    this.sources.get(mediaId)?.dispose();
    this.sources.delete(mediaId);
  }

  disposeAll(): void {
    for (const s of this.sources.values()) s.dispose();
    this.sources.clear();
  }
}
