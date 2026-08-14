import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  addTransition,
  formatTimecode,
  getTransitionDef,
  nextClipOnTrack,
  removeTransition,
  renameTrack,
  resolvedTransitions,
  seconds,
  toSeconds,
  toggleTrackFlag,
  type Clip,
  type Sequence,
  type Ticks,
  type Track,
} from '@opencut/core';
import { IconButton, Tooltip } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { usePlayback } from '../state/playbackContext.js';
import { ClipContextMenu } from './ClipContextMenu.js';
import {
  beginClipDrag,
  clipDragReadout,
  isClipDragging,
  subscribeClipDrag,
  type ClipDragMode,
} from './clipDrag.js';

/**
 * How tall to draw a track.
 *
 * `Track.height` is a model field, but nothing in the app can change it — there is no per-track
 * resize handle — so every track carries the same factory default and the field is effectively a
 * constant. The Interface preference is therefore the real control, and the model value is only
 * honoured when a project explicitly disagrees with the factory default (a hand-edited file, or
 * a future resize handle), which keeps the preference from silently overriding real data.
 */
const FACTORY_HEIGHT = { video: 72, audio: 56 } as const;
const useTrackHeight = (track: Track): number => {
  const pref = useStore((s) => s.preferences.timelineHeight);
  const kind = track.kind === 'audio' ? 'audio' : 'video';
  // A project carrying a non-factory height means someone set it deliberately; leave it alone.
  if (track.height !== FACTORY_HEIGHT[kind]) return track.height;
  // Audio lanes stay proportionally shorter, as the factory defaults intended.
  return kind === 'audio'
    ? Math.round(pref * (FACTORY_HEIGHT.audio / FACTORY_HEIGHT.video))
    : pref;
};

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
              <Lane key={track.id} track={track} toPx={toPx} toTicks={toTicks} />
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
  const height = useTrackHeight(track);
  return (
    <div className="oc-track-head" style={{ height }}>
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
  toPx,
  toTicks,
}: {
  track: Track;
  toPx: (t: Ticks) => number;
  toTicks: (px: number) => Ticks;
}) {
  const store = useAppStore();
  const height = useTrackHeight(track);

  // Transitions drawn for this lane, resolved against their clips. A transition whose clips
  // are gone simply does not appear — `resolvedTransitions` applies that rule in one place.
  const joins = resolvedTransitions(track);

  // Accept media dropped from the library onto this lane.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();

    // A transition dropped from the browser attaches to the nearest CUT, not to wherever the
    // cursor happened to land: a transition belongs to a join, and asking the user to hit a
    // zero-width boundary with a drop would be a precision game with no purpose.
    const transitionType = e.dataTransfer.getData('application/x-opencut-transition');
    if (transitionType) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const scroller = (e.currentTarget as HTMLElement).closest('.oc-timeline__scroll');
      const x = e.clientX - rect.left + (scroller?.scrollLeft ?? 0);
      applyTransitionAtTime(store, track, toTicks(x), transitionType);
      return;
    }

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
      style={{ height }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {track.clips.map((clip) => (
        <TimelineClip key={clip.id} clip={clip} track={track} toPx={toPx} />
      ))}
      {joins.map((j) => (
        <TransitionMarker key={j.transition.id} track={track} join={j} toPx={toPx} />
      ))}
    </div>
  );
});

/**
 * The badge drawn over a cut that carries a transition.
 *
 * Sized to the transition's REAL window rather than to a fixed pill, so its width is the
 * feedback for how long it lasts — dragging the duration slider visibly grows it. A fixed-size
 * icon would leave the duration invisible until playback.
 */
function TransitionMarker({
  track,
  join,
  toPx,
}: {
  track: Track;
  join: ReturnType<typeof resolvedTransitions>[number];
  toPx: (t: Ticks) => number;
}) {
  const store = useAppStore();
  const selected = useStore(
    (s) => s.selectedTransition?.id === join.transition.id && s.selectedTransition?.trackId === track.id,
  );
  const def = getTransitionDef(join.transition.type);
  const left = toPx(join.start);
  const width = Math.max(14, toPx(join.end) - left);

  return (
    <div
      className={`oc-transition${selected ? ' oc-transition--selected' : ''}`}
      style={{ left, width }}
      title={`${def?.label ?? join.transition.type} — click to edit, double-click to remove`}
      onPointerDown={(e) => {
        e.stopPropagation(); // or the lane's own handlers move the playhead underneath us
        store.getState().selectTransition({ trackId: track.id, id: join.transition.id });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        store.getState().dispatch(removeTransition(track.id, join.transition.id));
        store.getState().selectTransition(null);
      }}
    >
      <span className="oc-transition__glyph" />
      {width > 46 && <span className="oc-transition__label">{def?.label ?? join.transition.type}</span>}
    </div>
  );
}

/**
 * Attach a transition at the cut nearest `time` on this track.
 *
 * Shared by the lane's drop handler and the browser's click-to-apply, so both land a transition
 * in exactly the same place. Reports why nothing happened when there is no usable join —
 * silence here reads as a broken drag.
 */
export function applyTransitionAtTime(
  store: ReturnType<typeof useAppStore>,
  track: Track,
  time: Ticks,
  type: string,
): void {
  const notify = store.getState().notify;
  if (track.clips.length < 2) {
    notify('Transitions need two clips', 'info', 'Place a second clip on this track first.');
    return;
  }
  // Candidate joins: every clip that has an adjacent neighbour after it.
  const joins = track.clips
    .map((clip) => ({ clip, next: nextClipOnTrack(track, clip) }))
    .filter((j): j is { clip: Clip; next: Clip } => !!j.next)
    .map((j) => ({ ...j, cut: Math.min(j.clip.start + j.clip.duration, j.next.start) }));
  if (joins.length === 0) {
    notify('No cut to attach to', 'info', 'Transitions go between two touching clips.');
    return;
  }
  const best = joins.reduce((a, b) => (Math.abs(b.cut - time) < Math.abs(a.cut - time) ? b : a));
  // A default of one second, clamped by `transitionWindow` against the clips it joins — so a
  // drop onto two very short clips still produces something that fits.
  const duration = seconds(1);
  store.getState().dispatch(addTransition(track.id, best.clip.id, best.next.id, type, duration));
  notify(`${getTransitionDef(type)?.label ?? type} added`, 'success');
}

/**
 * PERF: memoized. It no longer takes the whole `sequence` (which changes reference on every
 * edit); it reads it from the store only inside drag handlers. So editing one clip doesn't
 * re-render every other clip — only clips whose own `clip`/`track` prop actually changed.
 */
const TimelineClip = memo(function TimelineClip({
  clip,
  track,
  toPx,
}: {
  clip: Clip;
  track: Track;
  toPx: (t: Ticks) => number;
}) {
  const store = useAppStore();
  const selected = useStore((s) => s.selectedClipIds.includes(clip.id));
  const showThumb = useStore((s) => s.preferences.timelineThumbnails);
  const media = useStore((s) =>
    clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined,
  );
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  /*
   * The live readout comes from the drag session, not from this component's state: the session
   * outlives a remount and this component does not, so a clip dragged onto another track keeps
   * its readout instead of losing it at the lane boundary.
   */
  const readout = useSyncExternalStore(subscribeClipDrag, () => clipDragReadout(clip.id));
  // Drives `cursor: grabbing` for the whole gesture, including the stretches where the pointer
  // has outrun the clip and is no longer over it.
  const dragging = useSyncExternalStore(subscribeClipDrag, () => isClipDragging(clip.id));

  const beginDrag = (mode: ClipDragMode) => (e: React.PointerEvent) => {
    if (track.locked) return;
    // Only the primary button drags. Right-click belongs to the context menu, and letting it
    // arm a drag left the gesture half-open when the menu swallowed the matching release.
    if (e.button !== 0) return;
    e.stopPropagation();
    store.getState().selectClip(clip.id, e.shiftKey);
    /*
     * Deliberately no `setPointerCapture`: capture binds the gesture to this element, and this
     * element is exactly what disappears when the clip crosses to another track. The session
     * listens on the window instead, which survives the remount.
     */
    beginClipDrag({
      store,
      clipId: clip.id,
      mode,
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      origStart: clip.start,
      origDur: clip.duration,
    });
  };

  const left = toPx(clip.start);
  const width = Math.max(6, toPx(clip.duration));

  return (
    <>
      <div
        className="oc-clip"
        data-kind={clip.kind}
        data-selected={selected}
        data-dragging={dragging}
        style={{ left, width }}
        /*
         * Only the press is bound here. Everything that continues or ends the gesture —
         * pointermove, pointerup, pointercancel, lostpointercapture, losing the window — is
         * handled by the drag session on the window, so none of it depends on this element
         * still existing. That is what lets a drag cross tracks: this component is unmounted
         * and rebuilt in the new lane mid-gesture, and the drag does not notice.
         */
        onPointerDown={beginDrag('move')}
        /*
         * Kill the browser's native drag-and-drop on the clip.
         *
         * `<img>` is draggable by default, and the clip's thumbnail covers its whole body — so
         * pressing the clip and moving handed the gesture to HTML5 drag-and-drop instead of us:
         * the browser lifted a translucent ghost of the thumbnail, showed a no-drop cursor, and
         * fired `pointercancel`, which correctly ended our drag. The clip stopped dead while the
         * ghost followed the mouse, which is the "stuck / fighting the cursor" behaviour.
         *
         * The image also carries `draggable={false}`, but this guard is what makes it safe: it
         * covers anything droppable added to a clip later, not just today's thumbnail.
         */
        onDragStart={(e) => e.preventDefault()}
        onContextMenu={(e) => {
          e.preventDefault();
          store.getState().selectClip(clip.id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={() => store.getState().setInspectorTab(clip.kind === 'text' ? 'text' : 'transform')}
      >
        {/*
          The handles own only the press that picks the edge. They once carried their own
          pointermove/pointerup as well as bubbling into the body's copies, so a single event ran
          the trim twice — same delta applied twice, and the edge tore away at double the
          cursor's speed. With the session on the window there is exactly one handler for the
          whole timeline, so that class of double-application cannot recur.
        */}
        <div className="oc-clip__handle oc-clip__handle--in" onPointerDown={beginDrag('in')} />
        <div className="oc-clip__label">{clip.name}</div>
        <div className="oc-clip__body">
          {showThumb && media?.thumbnail && clip.kind !== 'audio' && (
            <img className="oc-clip__thumb" src={media.thumbnail} alt="" draggable={false} />
          )}
          {clip.kind === 'audio' && <Waveform seed={clip.id} />}
        </div>
        {clip.effects.length > 0 && (
          <div className="oc-clip__fx">
            <span style={{ fontSize: 9, fontWeight: 700 }}>fx {clip.effects.length}</span>
          </div>
        )}
        <div className="oc-clip__handle oc-clip__handle--out" onPointerDown={beginDrag('out')} />
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
