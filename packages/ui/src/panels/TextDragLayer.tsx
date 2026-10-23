/**
 * Lets a title be grabbed in the preview and moved anywhere in the frame.
 *
 * A transparent layer over the preview canvas. Text is drawn by the compositor, so the DOM knows
 * nothing about where it is; instead this works the position out from the clip's own transform
 * (`clipQuad` mirrors the compositor's matrix), finds the topmost text clip under the pointer, and
 * drags it by writing `setClipPosition` — one undo step per drag, keyframed if the position is
 * animated, exactly as the Inspector's Position fields behave. Dragging snaps to the frame's centre
 * lines, with a guide shown while it does.
 */

import { useRef, useState } from 'react';
import { clipQuad, quadContains, sample, setClipPosition, videoTracksTopDown, type Clip, type ClipQuad, type Sequence, type Ticks } from '@opencut/core';
import { rasterizeText } from '@opencut/engine';
import { useAppStore, useStore } from '../state/context.js';

/** Distance, in preview pixels, within which a drag snaps to a centre line. */
const SNAP_VIEW_PX = 8;

interface Box {
  clip: Clip;
  quad: ClipQuad;
}

/** Every text clip on screen at `time`, topmost first. Locked and hidden tracks are left alone. */
function activeTextBoxes(seq: Sequence, time: Ticks): Box[] {
  const out: Box[] = [];
  for (const track of videoTracksTopDown(seq)) {
    if (track.hidden || track.locked) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'text' || !clip.text || !clip.enabled) continue;
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      const raster = rasterizeText(clip.text);
      if (!raster) continue;
      const local = (time - clip.start) as Ticks;
      out.push({
        clip,
        quad: clipQuad(
          seq,
          {
            x: sample(clip.transform.x, local),
            y: sample(clip.transform.y, local),
            scaleX: sample(clip.transform.scaleX, local),
            scaleY: sample(clip.transform.scaleY, local),
            rotation: sample(clip.transform.rotation, local),
          },
          raster,
        ),
      });
    }
  }
  return out;
}

export function TextDragLayer() {
  const store = useAppStore();
  const seq = useStore((s) => s.sequence());
  const playhead = useStore((s) => s.playhead);
  const selected = useStore((s) => s.selectedClipIds);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: Clip['id']; pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [guides, setGuides] = useState({ x: false, y: false });
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);

  const boxes = activeTextBoxes(seq, playhead);

  /** Pointer position in sequence pixels, and how many sequence pixels one preview pixel is. */
  const toSeq = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * seq.width, y: ((e.clientY - r.top) / r.height) * seq.height, k: seq.width / r.width };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toSeq(e);
    const hit = boxes.find((b) => quadContains(b.quad, p.x, p.y));
    if (!hit) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    store.getState().selectClip(hit.clip.id);
    drag.current = {
      id: hit.clip.id,
      pointerId: e.pointerId,
      startX: p.x,
      startY: p.y,
      originX: hit.quad.cx - seq.width / 2,
      originY: hit.quad.cy - seq.height / 2,
    };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = toSeq(e);
    if (!d || e.pointerId !== d.pointerId) {
      const over = boxes.some((b) => quadContains(b.quad, p.x, p.y));
      if (over !== hover) setHover(over);
      return;
    }
    let nx = d.originX + (p.x - d.startX);
    let ny = d.originY + (p.y - d.startY);
    const snap = SNAP_VIEW_PX * p.k;
    const gx = Math.abs(nx) < snap;
    const gy = Math.abs(ny) < snap;
    if (gx) nx = 0;
    if (gy) ny = 0;
    setGuides((g) => (g.x === gx && g.y === gy ? g : { x: gx, y: gy }));
    store.getState().dispatch(setClipPosition(d.id, Math.round(nx), Math.round(ny), store.getState().playhead));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    setDragging(false);
    setGuides({ x: false, y: false });
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={ref}
      className={`oc-textdrag${hover || dragging ? ' oc-textdrag--grab' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHover(false)}
    >
      {boxes
        .filter((b) => selected.includes(b.clip.id))
        .map((b) => (
          <div
            key={b.clip.id}
            className="oc-textdrag__box"
            style={{
              left: `${((b.quad.cx - b.quad.halfW) / seq.width) * 100}%`,
              top: `${((b.quad.cy - b.quad.halfH) / seq.height) * 100}%`,
              width: `${((b.quad.halfW * 2) / seq.width) * 100}%`,
              height: `${((b.quad.halfH * 2) / seq.height) * 100}%`,
              // CSS rotates clockwise; the model's rotation is counter-clockwise.
              transform: `rotate(${-b.quad.rotation}deg)`,
            }}
          />
        ))}
      {guides.x && <div className="oc-textdrag__guide oc-textdrag__guide--v" />}
      {guides.y && <div className="oc-textdrag__guide oc-textdrag__guide--h" />}
    </div>
  );
}
