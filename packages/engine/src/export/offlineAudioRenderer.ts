/**
 * OfflineAudioRenderer — mixes a sequence's audio to a single PCM track for export.
 *
 * The realtime AudioEngine (audioGraph.ts) is element-based and cannot render offline, so
 * export uses this separate, additive path: fetch each audible clip's media, decode it, and
 * schedule it on an OfflineAudioContext with the same gain/fade/mute/solo rules, then render
 * faster-than-realtime to a WAV buffer that ffmpeg muxes with the video. Nothing here touches
 * the realtime engine.
 */

import { sample, toSeconds, type MediaAsset, type Sequence } from '@opencut/core';

/**
 * Render the sequence audio to a 16-bit stereo WAV. Returns null if there is nothing audible
 * (so the caller can export a video-only file). Runs in the renderer (Web Audio APIs).
 */
export async function renderSequenceAudioWav(
  sequence: Sequence,
  getMedia: (id: string) => MediaAsset | undefined,
  resolveUrl: (src: string) => string,
): Promise<ArrayBuffer | null> {
  const durationSec = toSeconds(sequence.duration);
  if (durationSec <= 0) return null;

  const sampleRate = sequence.sampleRate || 48000;
  const soloed = sequence.tracks.some((t) => t.solo);

  // Gather audible clips (audio clips + video clips carrying audio).
  interface Job {
    src: string;
    startSec: number;
    offsetSec: number;
    durationSec: number;
    gain: number;
    fadeInSec: number;
    fadeOutSec: number;
    rate: number;
  }
  const jobs: Job[] = [];
  for (const track of sequence.tracks) {
    const audible = !track.muted && (!soloed || track.solo);
    if (!audible) continue;
    for (const clip of track.clips) {
      if (!clip.mediaId || !clip.audio || clip.audio.muted) continue;
      const media = getMedia(clip.mediaId);
      if (!media || (media.kind !== 'audio' && !media.hasAudio)) continue;
      jobs.push({
        src: media.src,
        startSec: toSeconds(clip.start),
        offsetSec: toSeconds(clip.sourceIn),
        durationSec: toSeconds(clip.duration),
        gain: Math.max(0, sample(clip.audio.volume, 0)),
        fadeInSec: toSeconds(clip.audio.fadeIn),
        fadeOutSec: toSeconds(clip.audio.fadeOut),
        rate: Math.abs(clip.speed.rate) || 1,
      });
    }
  }
  if (jobs.length === 0) return null;

  const ctx = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);

  // Decode each unique source once.
  const cache = new Map<string, AudioBuffer | null>();
  const decode = async (src: string): Promise<AudioBuffer | null> => {
    if (cache.has(src)) return cache.get(src)!;
    let buf: AudioBuffer | null = null;
    try {
      const res = await fetch(resolveUrl(src));
      const bytes = await res.arrayBuffer();
      buf = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      buf = null; // undecodable (e.g. a codec Web Audio can't handle) — skip this clip
    }
    cache.set(src, buf);
    return buf;
  };

  for (const j of jobs) {
    const buffer = await decode(j.src);
    if (!buffer) continue;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = j.rate;
    const gain = ctx.createGain();
    // Fade envelope on top of the clip's base volume.
    const g = j.gain;
    const start = j.startSec;
    const end = start + j.durationSec;
    gain.gain.setValueAtTime(j.fadeInSec > 0 ? 0 : g, start);
    if (j.fadeInSec > 0) gain.gain.linearRampToValueAtTime(g, start + Math.min(j.fadeInSec, j.durationSec));
    if (j.fadeOutSec > 0) {
      gain.gain.setValueAtTime(g, Math.max(start, end - j.fadeOutSec));
      gain.gain.linearRampToValueAtTime(0, end);
    }
    node.connect(gain).connect(ctx.destination);
    // Play the trimmed source window at the clip's timeline position.
    node.start(start, j.offsetSec, j.durationSec * j.rate);
  }

  const rendered = await ctx.startRendering();
  return audioBufferToWav(rendered);
}

/** Encode an AudioBuffer as a 16-bit PCM WAV (interleaved). */
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}
