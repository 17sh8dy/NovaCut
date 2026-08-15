/**
 * AudioEngine — a Web Audio mixing graph driven by the same playhead as the compositor.
 *
 * Each audio-bearing clip gets its own <audio> element → MediaElementSource → per-clip
 * GainNode (volume + fades + mute/solo) → master GainNode → destination. The engine keeps
 * element playback in sync with the transport and applies automation each tick.
 *
 * This is deliberately element-based (not fully sample-accurate). The class is the seam:
 * swapping to an AudioWorklet/OfflineAudioContext for export-quality mixing changes only
 * this file.
 */

import {
  sample,
  toSeconds,
  type Clip,
  type MediaAsset,
  type Sequence,
  type Ticks,
} from '@opencut/core';
import { dlog, dthrottle } from '../debug.js';

interface ClipNode {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext;
  private master: GainNode;
  private analyser: AnalyserNode;
  private analyserBuf: Float32Array<ArrayBuffer>;
  private nodes = new Map<string, ClipNode>();
  private playing = false;

  constructor(private resolveUrl: (src: string) => string) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    // Tap the master bus so we can measure the ACTUAL PCM level going to the output device
    // (our stand-in for "PCM samples produced / audio device writes").
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Back the view with a plain ArrayBuffer (not ArrayBufferLike) so it satisfies
    // AnalyserNode.getFloatTimeDomainData's typed-array signature.
    this.analyserBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.master.connect(this.analyser);
    this.master.connect(this.ctx.destination);
    dlog('audio', 'AudioEngine created', {
      ctxState: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      baseLatency: this.ctx.baseLatency,
      destChannels: this.ctx.destination.maxChannelCount,
    });
  }

  /** Read the master-bus RMS — nonzero means PCM is actually flowing to the device. */
  private measureOutput(): number {
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    let sum = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) sum += this.analyserBuf[i]! * this.analyserBuf[i]!;
    return Math.sqrt(sum / this.analyserBuf.length);
  }

  setMasterVolume(v: number): void {
    this.master.gain.value = Math.max(0, v);
  }

  /** Build (or reuse) an audio node for a clip's media. */
  private nodeFor(clip: Clip, media: MediaAsset): ClipNode {
    let node = this.nodes.get(clip.id);
    if (node) return node;
    const url = this.resolveUrl(media.src);
    const el = new Audio(url);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.oncanplay = () => dlog('audio', 'element canplay', { clip: clip.id, readyState: el.readyState, dur: el.duration });
    el.onplaying = () => dlog('audio', 'element playing', { clip: clip.id, currentTime: el.currentTime });
    el.onerror = () => dlog('audio', 'element ERROR', { clip: clip.id, code: el.error?.code, message: el.error?.message, url });
    el.onstalled = () => dlog('audio', 'element stalled', { clip: clip.id });
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    source.connect(gain).connect(this.master);
    node = { el, source, gain };
    this.nodes.set(clip.id, node);
    dlog('audio', 'clip audio node created', { clip: clip.id, mediaId: media.id, url, hasAudio: media.hasAudio });
    return node;
  }

  /** Resume the context (must follow a user gesture) and mark playing. */
  async play(): Promise<void> {
    const before = this.ctx.state;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.playing = true;
    dlog('audio', 'play() — context resume', { stateBefore: before, stateAfter: this.ctx.state, nodes: this.nodes.size });
  }

  pause(): void {
    this.playing = false;
    for (const n of this.nodes.values()) n.el.pause();
    dlog('audio', 'pause()', { nodes: this.nodes.size, ctxState: this.ctx.state });
  }

  /**
   * Reconcile audio to the timeline at `time`. Called every tick: starts/stops elements,
   * seeks them to the right source offset, and applies volume + fades + mute/solo.
   */
  update(
    sequence: Sequence,
    time: Ticks,
    getMedia: (id: string) => MediaAsset | undefined,
    speed = 1,
  ): void {
    const soloed = sequence.tracks.some((t) => t.solo);
    let audibleClips = 0;
    /** Every clip this sequence still has a node for; anything else is pruned below. */
    const live = new Set<string>();
    // Iterate every track: audio clips AND video clips that carry embedded audio.
    for (const track of sequence.tracks) {
      const audible = !track.muted && (!soloed || track.solo);
      for (const clip of track.clips) {
        if (!clip.mediaId || !clip.audio) continue;
        const media = getMedia(clip.mediaId);
        if (!media) continue;
        const node = this.nodeFor(clip, media);
        live.add(clip.id);
        const inClip = time >= clip.start && time < clip.start + clip.duration;

        if (inClip && audible && !clip.audio.muted) {
          const localTicks = time - clip.start;
          const sourceTime = toSeconds(clip.sourceIn + localTicks * (clip.speed.reverse ? -1 : clip.speed.rate));
          if (Math.abs(node.el.currentTime - sourceTime) > 0.2) node.el.currentTime = sourceTime;
          // × preview speed so audio keeps pace with the playhead (same reason as video).
          node.el.playbackRate = Math.max(0.0625, Math.min(16, Math.abs(clip.speed.rate) * speed));
          node.gain.gain.value = this.gainFor(clip, localTicks);
          const wasPaused = node.el.paused;
          if (this.playing && node.el.paused) void node.el.play().catch((e) => dlog('audio', 'el.play() rejected', { clip: clip.id, err: String(e) }));
          audibleClips++;
          dthrottle(`aclip:${clip.id}`, 500, 'audio', () => [
            'reconcile clip AUDIBLE',
            {
              clip: clip.id,
              engPlaying: this.playing,
              elPaused: node.el.paused,
              wasPaused,
              readyState: node.el.readyState,
              elCurrentTime: Number(node.el.currentTime.toFixed(3)),
              wantTime: Number(sourceTime.toFixed(3)),
              gain: Number(node.gain.gain.value.toFixed(3)),
            },
          ]);
        } else {
          if (!node.el.paused) node.el.pause();
          node.gain.gain.value = 0;
          dthrottle(`aclip:${clip.id}`, 1000, 'audio', () => [
            'reconcile clip SILENT',
            { clip: clip.id, inClip, trackAudible: audible, clipMuted: clip.audio?.muted },
          ]);
        }
      }
    }
    this.prune(live);
    // The ground truth: is PCM actually reaching the device?
    dthrottle('outlevel', 500, 'audio', () => [
      'OUTPUT master RMS',
      { rms: Number(this.measureOutput().toFixed(5)), ctxState: this.ctx.state, engPlaying: this.playing, audibleClips },
    ]);
  }

  /**
   * Drop the nodes of clips that no longer exist.
   *
   * `update()` reconciles by walking the CLIPS, so a clip that has been deleted is simply not
   * visited — and its element, which `update()` had already started, was therefore never told to
   * stop. Deleting a clip mid-playback left its audio playing on over the timeline until the
   * transport was paused, with nothing on screen it could be traced back to.
   *
   * The map is keyed by clip id and every split mints new ones, so an editing session also grew
   * an `<audio>` element, a MediaElementSource and a GainNode per discarded clip, all still
   * wired to the master bus. Pruning is what makes the graph match the timeline rather than the
   * history of it.
   *
   * A source node cannot be reconnected to another element once created, so a pruned clip that
   * comes back (undo) correctly gets a fresh node from `nodeFor`.
   */
  private prune(live: Set<string>): void {
    for (const [clipId, node] of this.nodes) {
      if (live.has(clipId)) continue;
      node.el.pause();
      node.el.removeAttribute('src');
      node.el.load(); // release the decoder; pause() alone keeps the download alive
      node.source.disconnect();
      node.gain.disconnect();
      this.nodes.delete(clipId);
      dlog('audio', 'clip audio node pruned', { clip: clipId });
    }
  }

  /** Volume automation × fade envelope for a clip at a local time. */
  private gainFor(clip: Clip, localTicks: Ticks): number {
    const a = clip.audio!;
    let g = sample(a.volume, localTicks);
    if (a.fadeIn > 0 && localTicks < a.fadeIn) g *= localTicks / a.fadeIn;
    const remaining = clip.duration - localTicks;
    if (a.fadeOut > 0 && remaining < a.fadeOut) g *= Math.max(0, remaining / a.fadeOut);
    return Math.max(0, g);
  }

  seek(): void {
    // Next update() reconciles element positions; nothing to do eagerly.
  }

  dispose(): void {
    for (const n of this.nodes.values()) {
      n.el.pause();
      n.source.disconnect();
      n.gain.disconnect();
    }
    this.nodes.clear();
    void this.ctx.close();
  }
}
