import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Volume2,
  VolumeX,
  Magnet,
  Plus,
  Scissors,
  ZoomIn,
  ZoomOut,
  Headphones,
} from 'lucide-react';
import {
  addTrack,
  formatTimecode,
  moveClip,
  renameTrack,
  seconds,
  snapTargets,
  toSeconds,
  toggleTrackFlag,
  trimClip,
  type Clip,
  type Sequence,
  type Ticks,
  type Track,
} from '@opencut/core';
import { IconButton, Tooltip } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { usePlayback } from '../state/playbackContext.js';
import { ClipContextMenu } from './ClipContextMenu.js';

/** Convert between ticks and pixels for the current zoom. */
const useScale = () => {
  const pps = useStore((s) => s.pixelsPerSecond);
  return {
    pps,
    toPx: (t: Ticks) => toSeconds(t) * pps,
    toTicks: (px: number) => seconds(px / pps),
  };
};

export function Timeline() {
  const engine = usePlayback();
  const store = useAppStore();
  const seq = useStore((s) => s.sequence());
  const pps = useStore((s) => s.pixelsPerSecond);
  const snap = useStore((s) => s.snapEnabled);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const { toPx, toTicks } = useScale();

  // Auto-scroll to keep the playhead in view during playback (pref-gated). Subscribes to the
  // store directly (not via useStore) so this does NOT re-render the Timeline every frame.
  useEffect(() => {
    const unsub = store.subscribe((s) => {
      const el = scrollRef.current;
      if (!el || !s.isPlaying || !s.preferences.autoScrollDuringPlayback) return;
      const x = toPx(s.playhead);
      const left = el.scrollLeft;
      const right = left + el.clientWidth;
      // When the playhead nears either edge, recenter the view on it.
      if (x < left + 48 || x > right - 120) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.5);
    });
    return unsub;
  }, [store, toPx]);

  // Ctrl/Cmd + mouse wheel zooms the timeline. Registered non-passive so preventDefault works
  // (otherwise the OS/browser would zoom the whole page).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const s = store.getState();
      s.setPixelsPerSecond(s.pixelsPerSecond * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [store]);

  const contentWidth = Math.max(2000, toPx(seq.duration) + 600);

  // Keep the header column's vertical scroll aligned with the lanes.
  const onScroll = () => {
    if (headersRef.current && scrollRef.current) headersRef.current.scrollTop = scrollRef.current.scrollTop;
  };

  // Smooth scrubbing: coalesce rapid pointer moves to ONE seek per animation frame (latest
  // position wins). Fast drags no longer queue a backlog of seeks, so the preview tracks the
  // cursor without lag. The engine's FrameSource further coalesces the resulting video seeks
  // (latest-wins), which keeps even 4K sources responsive. Playback resumes from wherever the
  // scrub left the playhead (the clock's position is what play() continues from).
  const pendingX = useRef<number | null>(null);
  const scrubRaf = useRef(0);
  const seekFromEvent = (clientX: number) => {
    pendingX.current = clientX;
    if (scrubRaf.current) return; // a frame is already scheduled; it will read the latest X
    scrubRaf.current = requestAnimationFrame(() => {
      scrubRaf.current = 0;
      const el = scrollRef.current;
      if (el && pendingX.current != null) {
        const rect = el.getBoundingClientRect();
        const x = pendingX.current - rect.left + el.scrollLeft;
        engine.seek(Math.max(0, toTicks(x)));
      }
      pendingX.current = null;
    });
  };

  return (
    <div className="oc-timeline">
      <TimelineToolbar />
      <div className="oc-timeline__body">
        <div className="oc-timeline__headers" ref={headersRef}>
          <div className="oc-ruler-spacer" />
          {seq.tracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
        </div>

        <div className="oc-timeline__scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="oc-timeline__content" style={{ width: contentWidth }}>
            <Ruler sequence={seq} pps={pps} onSeek={seekFromEvent} width={contentWidth} />
            {seq.tracks.map((track) => (
              <Lane key={track.id} track={track} snap={snap} toPx={toPx} toTicks={toTicks} />
            ))}
            <SnapGuide toPx={toPx} />
            <Playhead toPx={toPx} onSeek={seekFromEvent} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Magnetic snap guide: a vertical line shown at the tick the drag is snapping to. */
function SnapGuide({ toPx }: { toPx: (t: Ticks) => number }) {
  const guide = useStore((s) => s.snapGuide);
  if (guide == null) return null;
  return <div className="oc-snapline" style={{ left: toPx(guide) }} />;
}

/**
 * The red playhead. The thin line stays click-through so it never blocks clips, but its head
 * (in the ruler band) is a grab target: press and drag to scrub the sequence.
 *
 * PERF: it subscribes to `playhead` itself so that during playback only THIS component
 * re-renders each frame — not the whole Timeline (lanes + every clip). This is the main
 * reason the timeline stays at 60fps while playing.
 */
function Playhead({ toPx, onSeek }: { toPx: (t: Ticks) => number; onSeek: (clientX: number) => void }) {
  const playhead = useStore((s) => s.playhead);
  const [dragging, setDragging] = useState(false);
  return (
    <div className="oc-playhead" style={{ left: toPx(playhead) }}>
      <div
        className="oc-playhead__grab"
        onPointerDown={(e) => {
          e.stopPropagation();
          setDragging(true);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          onSeek(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging) onSeek(e.clientX);
        }}
        onPointerUp={(e) => {
          setDragging(false);
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
      />
    </div>
  );
}

function TimelineToolbar() {
  const store = useAppStore();
  const pps = useStore((s) => s.pixelsPerSecond);
  const snap = useStore((s) => s.snapEnabled);
  const ripple = useStore((s) => s.rippleEnabled);

  return (
    <div className="oc-timeline__toolbar">
      <Tooltip label="Split clip at playhead" shortcut="Ctrl+K">
        <IconButton onClick={() => store.getState().splitAtPlayhead()}>
          <Scissors size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Add video track">
        <IconButton onClick={() => store.getState().dispatch(addTrack('video'))}>
          <Plus size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Add audio track">
        <IconButton onClick={() => store.getState().dispatch(addTrack('audio'))}>
          <Headphones size={16} />
        </IconButton>
      </Tooltip>

      <div className="spacer" />

      <Tooltip label="Snapping">
        <IconButton active={snap} onClick={() => store.getState().toggleSnap()}>
          <Magnet size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Ripple edits">
        <IconButton active={ripple} onClick={() => store.getState().toggleRipple()}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>R</span>
        </IconButton>
      </Tooltip>

      <div className="oc-zoom">
        <IconButton size="sm" onClick={() => store.getState().setPixelsPerSecond(pps / 1.4)}>
          <ZoomOut size={15} />
        </IconButton>
        <input
          type="range"
          min={8}
          max={300}
          value={pps}
          onChange={(e) => store.getState().setPixelsPerSecond(+e.target.value)}
          style={{ width: 90 }}
        />
        <IconButton size="sm" onClick={() => store.getState().setPixelsPerSecond(pps * 1.4)}>
          <ZoomIn size={15} />
        </IconButton>
      </div>
    </div>
  );
}

function Ruler({
  sequence,
  pps,
  onSeek,
  width,
}: {
  sequence: Sequence;
  pps: number;
  onSeek: (clientX: number) => void;
  width: number;
}) {
  // Choose a tick interval (seconds) that keeps labels ~80px apart at this zoom.
  const targetPx = 80;
  const rawSeconds = targetPx / pps;
  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const stepSec = niceSteps.find((s) => s >= rawSeconds) ?? 600;
  const totalSec = width / pps;
  const marks: number[] = [];
  for (let s = 0; s <= totalSec; s += stepSec) marks.push(s);

  const [scrubbing, setScrubbing] = useState(false);

  return (
    <div
      className="oc-ruler"
      style={{ width }}
      onPointerDown={(e) => {
        setScrubbing(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onSeek(e.clientX);
      }}
      onPointerMove={(e) => scrubbing && onSeek(e.clientX)}
      onPointerUp={() => setScrubbing(false)}
    >
      {marks.map((s) => (
        <div key={s} className="oc-ruler__tick" style={{ left: s * pps }}>
          {formatTimecode(seconds(s), sequence.fps)}
        </div>
      ))}
    </div>
  );
}

const TrackHeader = memo(function TrackHeader({ track }: { track: Track }) {
  const store = useAppStore();
  const isAudio = track.kind === 'audio';
  return (
    <div className="oc-track-head" style={{ height: track.height }}>
      <input
        className="oc-track-head__name"
        defaultValue={track.name}
        onBlur={(e) => {
          if (e.target.value !== track.name) store.getState().dispatch(renameTrack(track.id, e.target.value));
        }}
      />
      <div className="oc-track-toggles">
        {isAudio ? (
          <button
            className="oc-tt"
            data-warn={track.muted}
            onClick={() => store.getState().dispatch(toggleTrackFlag(track.id, 'muted'))}
            title="Mute"
          >
            {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        ) : (
          <button
            className="oc-tt"
            data-warn={track.hidden}
            onClick={() => store.getState().dispatch(toggleTrackFlag(track.id, 'hidden'))}
            title="Hide"
          >
            {track.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        <button
          className="oc-tt"
          data-on={track.solo}
          onClick={() => store.getState().dispatch(toggleTrackFlag(track.id, 'solo'))}
          title="Solo"
        >
          <span style={{ fontSize: 10, fontWeight: 700 }}>S</span>
        </button>
        <button
          className="oc-tt"
          data-on={track.locked}
          onClick={() => store.getState().dispatch(toggleTrackFlag(track.id, 'locked'))}
          title="Lock"
        >
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
      </div>
    </div>
  );
});

const Lane = memo(function Lane({
  track,
  snap,
  toPx,
  toTicks,
}: {
  track: Track;
  snap: boolean;
  toPx: (t: Ticks) => number;
  toTicks: (px: number) => Ticks;
}) {
  const store = useAppStore();

  // Accept media dropped from the library onto this lane.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const mediaId = e.dataTransfer.getData('application/x-opencut-media');
    if (!mediaId) return;
    const media = store.getState().project.media.find((m) => m.id === mediaId);
    if (!media) return;
    if ((media.kind === 'audio') !== (track.kind === 'audio')) {
      return store.getState().notify('Drop audio on audio tracks', 'info');
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scroller = (e.currentTarget as HTMLElement).closest('.oc-timeline__scroll');
    const x = e.clientX - rect.left + (scroller?.scrollLeft ?? 0);
    store.getState().addMediaToTimeline(media, track.id, Math.max(0, toTicks(x)));
  };

  return (
    <div
      className="oc-lane"
      data-track-id={track.id}
      data-locked={track.locked}
      style={{ height: track.height }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {track.clips.map((clip) => (
        <TimelineClip key={clip.id} clip={clip} track={track} snap={snap} toPx={toPx} toTicks={toTicks} />
      ))}
    </div>
  );
});

/**
 * PERF: memoized. It no longer takes the whole `sequence` (which changes reference on every
 * edit); it reads it from the store only inside drag handlers. So editing one clip doesn't
 * re-render every other clip — only clips whose own `clip`/`track` prop actually changed.
 */
const TimelineClip = memo(function TimelineClip({
  clip,
  track,
  snap,
  toPx,
  toTicks,
}: {
  clip: Clip;
  track: Track;
  snap: boolean;
  toPx: (t: Ticks) => number;
  toTicks: (px: number) => Ticks;
}) {
  const store = useAppStore();
  const selected = useStore((s) => s.selectedClipIds.includes(clip.id));
  const showThumb = useStore((s) => s.preferences.timelineThumbnails);
  const media = useStore((s) =>
    clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined,
  );
  const drag = useRef<{ mode: 'move' | 'in' | 'out'; startX: number; origStart: Ticks; origDur: Ticks } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [readout, setReadout] = useState<string | null>(null); // live duration/position while dragging

  const beginDrag = (mode: 'move' | 'in' | 'out') => (e: React.PointerEvent) => {
    if (track.locked) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    store.getState().selectClip(clip.id, e.shiftKey);
    drag.current = { mode, startX: e.clientX, origStart: clip.start, origDur: clip.duration };
  };

  /**
   * Find the nearest magnetic snap target to `t` within the 8px threshold. Returns the snapped
   * value and the tick it snapped to (for the guide line), or null when nothing is in range or
   * snapping is disabled (globally off, or Alt held to temporarily bypass). The live playhead is
   * included alongside clip edges / in-out marks from snapTargets().
   */
  const snapResult = useCallback(
    (t: Ticks, disabled: boolean): { value: Ticks; guide: Ticks | null } => {
      if (!snap || disabled) return { value: t, guide: null };
      const s = store.getState();
      const threshold = toTicks(8);
      let best = t;
      let bestDist = threshold;
      let guide: Ticks | null = null;
      for (const target of [s.playhead, ...snapTargets(s.sequence(), clip.id)]) {
        const d = Math.abs(target - t);
        if (d < bestDist) {
          bestDist = d;
          best = target;
          guide = target;
        }
      }
      return { value: best, guide };
    },
    [snap, clip.id, toTicks, store],
  );

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const alt = e.altKey; // hold Alt to temporarily disable snapping
    const deltaTicks = toTicks(e.clientX - d.startX);
    const state = store.getState();
    if (d.mode === 'move') {
      // Detect a target track under the cursor for vertical (cross-track) moves.
      const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-id]');
      const targetTrackId = laneEl?.getAttribute('data-track-id') as string | null;
      const raw = Math.max(0, d.origStart + deltaTicks);
      // Snap either the leading OR trailing edge — whichever lands closest to a target.
      const lead = snapResult(raw, alt);
      const trail = snapResult(raw + clip.duration, alt);
      let newStart = raw;
      let guide: Ticks | null = null;
      const leadDist = lead.guide != null ? Math.abs(lead.value - raw) : Infinity;
      const trailDist = trail.guide != null ? Math.abs(trail.value - (raw + clip.duration)) : Infinity;
      if (leadDist <= trailDist && lead.guide != null) {
        newStart = Math.max(0, lead.value);
        guide = lead.guide;
      } else if (trail.guide != null) {
        newStart = Math.max(0, trail.value - clip.duration);
        guide = trail.guide;
      }
      state.setSnapGuide(guide);
      state.dispatch(moveClip(clip.id, newStart, (targetTrackId ?? undefined) as never, true));
      setReadout(formatTimecode(newStart, state.sequence().fps));
    } else if (d.mode === 'in') {
      const desired = snapResult(d.origStart + deltaTicks, alt);
      state.setSnapGuide(desired.guide);
      state.dispatch(trimClip(clip.id, 'in', desired.value - clip.start));
    } else {
      const desired = snapResult(d.origStart + d.origDur + deltaTicks, alt);
      state.setSnapGuide(desired.guide);
      const newDur = Math.max(seconds(0.05), desired.value - clip.start);
      state.dispatch(trimClip(clip.id, 'out', newDur - clip.duration));
    }
    // Show the resulting duration (trim) or start position (move) while dragging.
    if (d.mode !== 'move') {
      const cur = store.getState().selectedClip();
      if (cur && cur.id === clip.id) setReadout(formatTimecode(cur.duration, store.getState().sequence().fps));
    }
  };
  const endDrag = () => {
    drag.current = null;
    setReadout(null);
    store.getState().setSnapGuide(null); // hide the guide line when the drag ends
  };

  const left = toPx(clip.start);
  const width = Math.max(6, toPx(clip.duration));

  return (
    <>
      <div
        className="oc-clip"
        data-kind={clip.kind}
        data-selected={selected}
        style={{ left, width }}
        onPointerDown={beginDrag('move')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onContextMenu={(e) => {
          e.preventDefault();
          store.getState().selectClip(clip.id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={() => store.getState().setInspectorTab(clip.kind === 'text' ? 'text' : 'transform')}
      >
        <div className="oc-clip__handle oc-clip__handle--in" onPointerDown={beginDrag('in')} onPointerMove={onMove} onPointerUp={endDrag} />
        <div className="oc-clip__label">{clip.name}</div>
        <div className="oc-clip__body">
          {showThumb && media?.thumbnail && clip.kind !== 'audio' && <img className="oc-clip__thumb" src={media.thumbnail} alt="" />}
          {clip.kind === 'audio' && <Waveform seed={clip.id} />}
        </div>
        {clip.effects.length > 0 && (
          <div className="oc-clip__fx">
            <span style={{ fontSize: 9, fontWeight: 700 }}>fx {clip.effects.length}</span>
          </div>
        )}
        <div className="oc-clip__handle oc-clip__handle--out" onPointerDown={beginDrag('out')} onPointerMove={onMove} onPointerUp={endDrag} />
        {readout && <div className="oc-clip__readout">{readout}</div>}
      </div>
      {menu && <ClipContextMenu x={menu.x} y={menu.y} clip={clip} onClose={() => setMenu(null)} />}
    </>
  );
});

/** A cheap deterministic pseudo-waveform for audio clips (real peaks come from decode). */
function Waveform({ seed }: { seed: string }) {
  const bars = 40;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
  return (
    <div className="oc-clip__wave">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={{ height: `${20 + rand() * 60}%` }} />
      ))}
    </div>
  );
}
