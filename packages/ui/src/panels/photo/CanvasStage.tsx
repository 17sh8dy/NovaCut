/**
 * CanvasStage — the editing surface.
 *
 * Everything a user does directly to their artwork happens here: zoom, pan, select, move,
 * scale, rotate, draw a shape, type, crop. The GL canvas underneath is a passive output; this
 * component owns the *interaction*.
 *
 * ## Three coordinate spaces, and the one rule
 *
 *   screen   — client pixels from a PointerEvent.
 *   canvas   — document pixels. Everything in the model and every guide is in these.
 *   local    — a layer's own frame, centred on itself.
 *
 * The rule: convert to CANVAS space at the edge (`toCanvas`) and never think in screen pixels
 * again, except for the handful of things that must stay a constant size on screen — handle
 * squares, the snap tolerance, hit slop. Those divide by zoom exactly once, at the point of
 * use, and each one is commented where it happens. Zoom-dependent bugs all come from doing that
 * arithmetic twice, or in the wrong space.
 *
 * ## Why the overlay is an SVG in canvas coordinates
 *
 * The selection box has to sit exactly on the pixels the GPU drew, including under rotation and
 * flips. Rather than project four corners into screen space by hand, the overlay is an SVG
 * sized to the document and scaled by the same CSS transform as the canvas — so agreeing with
 * the renderer is structural rather than something to keep in sync. The geometry itself comes
 * from `@opencut/photo`, which is also what the renderer builds its matrix from.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { floodSelect, layoutText, traceMask } from '@opencut/engine';
import {
  addRasterLayer,
  addSelectionRegion,
  addShapeLayer,
  addTextLayer,
  applyMat,
  boundsOf,
  combineFromModifiers,
  cropCanvas,
  cssFont,
  deselect,
  drawGradient,
  ellipseRegion,
  extendStroke,
  fillBucket,
  fitModeOf,
  isTextLayer,
  mul as matMul,
  newPaintOpId,
  pathRegion,
  rectRegion,
  resolveCombine,
  resolvePaintTarget,
  setLayerTransform,
  setTextContent,
  type BrushSettings,
  type Fill,
  type Layer,
  type LayerId,
  type PaintTarget,
  type PhotoDocument,
  type Point,
  type Rect,
  type StrokePoint,
  type Transform2D,
} from '@opencut/photo';
import { EmptyState } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import type { PhotoEngine } from '../../state/usePhotoEngine.js';
import { cornersOf, hitTest, hitTestDeep, matrixOf, naturalSizeOf, snapMove, type SnapGuide } from './layerGeometry.js';
import { selectionOutline } from './selectionOutline.js';
import { isPaintTool, isSelectTool } from '../../state/photoStore.js';

/** Screen-space sizes that must not change with zoom. */
const HANDLE_PX = 9;
const ROTATE_RING_PX = 22;
const SNAP_TOLERANCE_PX = 7;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: { id: HandleId; fx: number; fy: number }[] = [
  { id: 'nw', fx: -1, fy: -1 },
  { id: 'n', fx: 0, fy: -1 },
  { id: 'ne', fx: 1, fy: -1 },
  { id: 'e', fx: 1, fy: 0 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0, fy: 1 },
  { id: 'sw', fx: -1, fy: 1 },
  { id: 'w', fx: -1, fy: 0 },
];

type Drag =
  | { mode: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | {
      mode: 'move';
      start: Point;
      ids: LayerId[];
      origins: Map<LayerId, { x: number; y: number }>;
      box: Rect;
      moved: boolean;
    }
  | {
      mode: 'scale';
      handle: HandleId;
      layerId: LayerId;
      /** The corner that stays put, in canvas pixels. */
      fixed: Point;
      /** Unit vectors of the layer's own axes, in canvas space. */
      axisX: Point;
      axisY: Point;
      base: { width: number; height: number };
      transform: Transform2D;
    }
  | { mode: 'rotate'; layerId: LayerId; centre: Point; startAngle: number; startRotation: number }
  | { mode: 'draw'; start: Point; current: Point }
  | { mode: 'crop'; start: Point; current: Point }
  | {
      mode: 'paint';
      layerId: LayerId;
      target: PaintTarget;
      strokeId: string;
      brush: BrushSettings;
      /** Points accumulated since the last dispatch — the command APPENDS, so this is a queue. */
      pending: StrokePoint[];
    }
  | {
      mode: 'gradient';
      layerId: LayerId;
      target: PaintTarget;
      opId: string;
      from: Point;
      fill: Fill;
      shape: 'linear' | 'radial';
    }
  | { mode: 'marquee'; start: Point; current: Point; ellipse: boolean; dragId: string; combine: ReturnType<typeof combineFromModifiers> }
  | { mode: 'lasso'; points: Point[]; dragId: string; combine: ReturnType<typeof combineFromModifiers> };

export function CanvasStage({ engine }: { engine: PhotoEngine }) {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const tool = usePhoto((s) => s.tool);
  const shapeKind = usePhoto((s) => s.shapeKind);
  const selection = usePhoto((s) => s.selection);
  const viewport = usePhoto((s) => s.viewport);
  const showRulers = usePhoto((s) => s.showRulers);
  const snapping = usePhoto((s) => s.snapping);
  const editingTextId = usePhoto((s) => s.editingTextId);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [preview, setPreview] = useState<Rect | null>(null);
  /** Vertices of a polygon lasso in progress. Empty when no polygon is being drawn. */
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);

  useEffect(() => {
    if (canvasRef.current) engine.attach(canvasRef.current);
  }, [engine]);

  // ── Fit to window ─────────────────────────────────────────────────────────
  //
  // Auto-fit stays on until the user zooms or pans by hand. Without that latch a window resize
  // — or the panel splitter moving one pixel — would yank the view back to fit and undo the
  // zoom they just dialled in.
  const fit = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    const pad = 48;
    const zoom = Math.min(
      (el.clientWidth - pad) / doc.width,
      (el.clientHeight - pad) / doc.height,
    );
    store.getState().setViewport({
      zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      panX: 0,
      panY: 0,
      autoFit: true,
    });
  }, [doc.width, doc.height, store]);

  // Re-fit when the canvas changes size, when auto-fit is turned back on, or when anything
  // explicitly asks for a fit. The nonce is what makes "Fit to window" work even though
  // `autoFit` is usually already true — see the field's note in the store.
  useLayoutEffect(() => {
    if (viewport.autoFit) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.width, doc.height, viewport.autoFit, viewport.fitNonce]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (store.getState().viewport.autoFit) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, store]);

  // Space temporarily turns any tool into the hand, the way it does in every editor. Tracked on
  // the window rather than the stage so it works even when focus is in a panel.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        setSpaceHeld(true);
        e.preventDefault(); // or the page scrolls under the canvas
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // A polygon in progress belongs to the polygon tool; switching away abandons it rather than
  // leaving vertices that would attach themselves to the next selection the user makes.
  useEffect(() => {
    if (tool !== 'polygon' && polyPoints.length > 0) setPolyPoints([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  useEffect(() => {
    if (tool !== 'polygon') return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Enter' && polyPoints.length >= 3) {
        e.preventDefault();
        closePolygon(polyPoints, resolveCombine('replace', store.getState().doc.selection));
        setPolyPoints([]);
      } else if (e.key === 'Escape' && polyPoints.length > 0) {
        e.preventDefault();
        setPolyPoints([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, polyPoints]);

  const { zoom, panX, panY } = viewport;

  /** Screen → canvas pixels. The single conversion point; see this file's header. */
  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const el = docRef.current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
    },
    [zoom],
  );

  // ── Wheel: zoom at the cursor, or pan ─────────────────────────────────────
  //
  // Anchoring the zoom at the POINTER, not the viewport centre, is the difference between
  // "zoom in on this" and "zoom in and then go hunting". The correction keeps the canvas point
  // under the cursor fixed: pan must absorb how far that point would otherwise have moved.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = store.getState();
      const v = state.viewport;
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        if (next === v.zoom) return;
        const rect = el.getBoundingClientRect();
        // Cursor position relative to the viewport centre, which is where pan is measured from.
        const cx = e.clientX - (rect.left + rect.width / 2);
        const cy = e.clientY - (rect.top + rect.height / 2);
        const k = next / v.zoom;
        state.setViewport({
          zoom: next,
          panX: cx - (cx - v.panX) * k,
          panY: cy - (cy - v.panY) * k,
          autoFit: false,
        });
      } else {
        state.setViewport({ panX: v.panX - e.deltaX, panY: v.panY - e.deltaY, autoFit: false });
      }
    };
    // Non-passive: the handler calls preventDefault, and Chromium ignores it otherwise.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [store]);

  // ── Pointer ───────────────────────────────────────────────────────────────

  /**
   * Take pointer capture, tolerating failure.
   *
   * `setPointerCapture` THROWS `InvalidPointerId` when the pointer is not currently active —
   * which happens for real on a fast click where the pointer is released between dispatch and
   * this call, and always for a synthetically dispatched event. An uncaught throw here aborts
   * the whole handler, so the drag never starts and the tool silently does nothing. Capture is
   * an optimisation (it keeps events coming when the cursor leaves the stage), not a
   * requirement, so losing it is far better than losing the interaction.
   */
  const capture = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* see above — the drag proceeds without capture */
    }
  };

  const beginPan = (e: React.PointerEvent) => {
    drag.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, panX, panY };
  };

  /**
   * The Magic Wand.
   *
   * Samples the COMPOSITED canvas — what the user can actually see — flood-fills from the click,
   * and traces the result into polygon contours. Those contours are what lands in the document;
   * the wand itself is not a stored region kind. See the header of `@opencut/photo`'s
   * `selection.ts` for why that indirection exists rather than storing the seed and tolerance.
   */
  const runWand = (p: Point, combine: ReturnType<typeof combineFromModifiers>) => {
    const gl = canvasRef.current;
    if (!gl) return;
    // Copy the GL canvas into a 2D one to read pixels. `preserveDrawingBuffer` is on (see
    // GLContext), so what is on screen is still there to be read.
    const work = document.createElement('canvas');
    work.width = gl.width;
    work.height = gl.height;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(gl, 0, 0);

    const image = ctx.getImageData(0, 0, work.width, work.height);
    const state = store.getState();
    const mask = floodSelect(image, p.x, p.y, {
      tolerance: state.sample.tolerance,
      contiguous: state.sample.contiguous,
    });
    const contours = traceMask(mask, work.width, work.height);
    if (contours.length === 0) return;
    state.dispatch(addSelectionRegion(pathRegion(contours.map((c) => c.map((q) => ({ x: q.x, y: q.y }))), combine)));
  };

  /** Finish a polygon lasso. Fewer than three points is not a shape, so it is dropped. */
  const closePolygon = (points: readonly Point[], combine: ReturnType<typeof combineFromModifiers>) => {
    if (points.length < 3) return;
    store.getState().dispatch(addSelectionRegion(pathRegion([[...points]], combine)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || spaceHeld || tool === 'hand') {
      capture(e);
      beginPan(e);
      return;
    }
    if (e.button !== 0) return;
    capture(e);
    const p = toCanvas(e);
    const state = store.getState();

    if (isPaintTool(tool)) {
      beginPaint(e, p);
      return;
    }
    if (isSelectTool(tool)) {
      beginSelect(e, p);
      return;
    }
    if (tool === 'crop') {
      drag.current = { mode: 'crop', start: p, current: p };
      setPreview(rectBetween(p, p));
      return;
    }
    if (tool === 'shape') {
      drag.current = { mode: 'draw', start: p, current: p };
      setPreview(rectBetween(p, p));
      return;
    }
    if (tool === 'text') {
      // Click-to-place, then straight into editing — a text tool that makes you click, then hunt
      // for the inspector, then type is three steps for one intention.
      state.dispatch(addTextLayer('Your text', {}, { x: p.x - doc.width / 2, y: p.y - doc.height / 2 }));
      // Re-read the store AFTER dispatching. `state` is a snapshot: Zustand replaces the state
      // object on every set, so `state.doc` here still points at the document from before the
      // layer existed — and the new layer would never be found, selected, or opened for editing.
      const added = store.getState().doc.layers.at(-1);
      // Drop back to Move BEFORE opening the editor. `setTool` closes any open text editor —
      // right when the user picks another tool, and it would silently undo this one if it ran
      // last. Ordering is the fix; making setTool conditional would just move the surprise.
      state.setTool('move');
      if (added) state.selectLayer(added.id, 'replace');

      // Opening the editor is deferred a frame, and that is not a hedge — it is required.
      // pointerdown is a DISCRETE event, so React flushes this handler's state synchronously:
      // the textarea would mount and focus itself while the event is still dispatching, and the
      // browser's own default action for mousedown (move focus to what was clicked) then runs
      // AFTER us and blurs it — which the editor reads as "clicked away" and closes. One frame
      // later, the default action is done and the focus sticks.
      if (added) requestAnimationFrame(() => store.getState().setEditingText(added.id));
      return;
    }

    // Move tool: a handle first (they sit on top of the artwork), then the artwork.
    const handle = handleUnder(p, state.selectedLayer(), doc, zoom);
    if (handle) {
      startHandleDrag(handle, p);
      return;
    }

    const hit = e.altKey ? hitTestDeep(p, doc) : hitTest(p, doc);
    if (!hit) {
      if (!e.shiftKey) state.selectLayer(null);
      return;
    }
    if (e.shiftKey) state.selectLayer(hit.id, 'toggle');
    else if (!state.selection.includes(hit.id)) state.selectLayer(hit.id, 'replace');

    const ids = store.getState().selection;
    const layers = store.getState().selectedLayers();
    drag.current = {
      mode: 'move',
      start: p,
      ids,
      origins: new Map(layers.map((l) => [l.id, { x: l.transform.x, y: l.transform.y }])),
      box: boundsOf(layers.flatMap((l) => cornersOf(l, doc))),
      moved: false,
    };
  };

  /**
   * Pressure, normalised.
   *
   * A mouse reports 0.5 while held and 0 otherwise, which would make every mouse stroke render
   * at half size on a pressure-sensitive brush. Only a pen has real pressure, so only a pen's
   * value is used; everything else paints at full.
   */
  const pressureOf = (e: React.PointerEvent): number =>
    e.pointerType === 'pen' ? Math.max(0.01, e.pressure) : 1;

  /**
   * Resolve where paint should land, creating a paint layer when there is nowhere to put it.
   *
   * The create-if-needed path is what makes the brush usable on a freshly imported photo: the
   * selected layer is a bitmap, which cannot be painted into without destroying it, so a paint
   * layer appears above it and the stroke goes there. Non-destructive by construction rather
   * than by the user remembering to add a layer first.
   */
  const ensurePaintSurface = (): { layerId: LayerId; target: PaintTarget } | null => {
    const state = store.getState();
    const resolved = resolvePaintTarget(state.doc, state.selectedLayerId, state.maskMode);
    if (!('needsNewLayer' in resolved)) return resolved;
    if (state.maskMode) return null; // mask mode with no mask: the inspector's job, not a silent create
    state.dispatch(addRasterLayer(resolved.aboveId));
    const added = store.getState().doc.layers.at(-1);
    if (!added) return null;
    state.selectLayer(added.id, 'replace');
    return { layerId: added.id, target: 'layer' };
  };

  const beginPaint = (e: React.PointerEvent, p: Point) => {
    const state = store.getState();
    const surface = ensurePaintSurface();
    if (!surface) return;

    if (tool === 'bucket') {
      state.dispatch(
        fillBucket(surface.layerId, surface.target, p, state.foreground, {
          tolerance: state.sample.tolerance,
          contiguous: state.sample.contiguous,
        }),
      );
      return;
    }
    if (tool === 'gradient') {
      drag.current = {
        mode: 'gradient',
        layerId: surface.layerId,
        target: surface.target,
        opId: newPaintOpId(),
        from: p,
        fill: state.gradientFill,
        shape: state.gradientShape,
      };
      return;
    }

    // Brush and eraser share everything but the composite mode; `kind` carries the difference.
    const brush: BrushSettings = {
      ...state.brush,
      kind: tool === 'eraser' ? 'eraser' : state.brush.kind === 'eraser' ? 'brush' : state.brush.kind,
      // A mask stores COVERAGE, not colour — the rasterizer reads only alpha there, so painting
      // white is what "reveal" means and the foreground swatch is irrelevant.
      color: surface.target === 'mask' ? '#ffffff' : state.foreground,
    };
    const strokeId = newPaintOpId();
    const first: StrokePoint = { x: p.x, y: p.y, p: pressureOf(e) };
    state.dispatch(extendStroke(surface.layerId, surface.target, strokeId, brush, [first]));
    drag.current = {
      mode: 'paint',
      layerId: surface.layerId,
      target: surface.target,
      strokeId,
      brush,
      pending: [],
    };
  };

  const beginSelect = (e: React.PointerEvent, p: Point) => {
    const state = store.getState();
    const combine = resolveCombine(combineFromModifiers(e.shiftKey, e.altKey), state.doc.selection);

    if (tool === 'wand') {
      runWand(p, combine);
      return;
    }
    if (tool === 'polygon') {
      // Click-to-add. Closing is handled by the click landing near the first point, or by
      // Enter / double-click — all three routed through `closePolygon`.
      setPolyPoints((pts) => {
        if (pts.length >= 3 && Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y) < 12 / zoom) {
          closePolygon(pts, combine);
          return [];
        }
        return [...pts, p];
      });
      return;
    }
    if (tool === 'lasso') {
      drag.current = { mode: 'lasso', points: [p], dragId: newPaintOpId(), combine };
      return;
    }
    drag.current = {
      mode: 'marquee',
      start: p,
      current: p,
      ellipse: tool === 'select-ellipse',
      dragId: newPaintOpId(),
      combine,
    };
    setPreview(rectBetween(p, p));
  };

  const startHandleDrag = (handle: { id: HandleId; rotate: boolean }, p: Point) => {
    const layer = store.getState().selectedLayer();
    if (!layer) return;
    const corners = cornersOf(layer, doc);
    const centre = centroid(corners);
    if (handle.rotate) {
      drag.current = {
        mode: 'rotate',
        layerId: layer.id,
        centre,
        startAngle: Math.atan2(p.y - centre.y, p.x - centre.x),
        startRotation: layer.transform.rotation,
      };
      return;
    }
    const spec = HANDLES.find((h) => h.id === handle.id)!;
    const m = matrixOf(layer, doc);
    const base = baseSizeOf(layer, doc);
    // The layer's own axes in canvas space, as unit vectors — from rotation and flip ONLY, not
    // from the full matrix. Excluding scale is deliberate: it lets a drag past the fixed point
    // produce a NEGATIVE scale, which is how dragging a handle through the opposite side flips
    // the layer. Folding the scale sign into the axis would cancel that out to a no-op.
    const rad = (layer.transform.rotation * Math.PI) / 180;
    const axisX = mul({ x: Math.cos(rad), y: Math.sin(rad) }, layer.transform.flipH ? -1 : 1);
    const axisY = mul({ x: -Math.sin(rad), y: Math.cos(rad) }, layer.transform.flipV ? -1 : 1);
    // The fixed point is the opposite corner (or the opposite edge's midpoint for an edge
    // handle), taken through the real matrix so it lands exactly on the drawn artwork.
    const fixed = applyMat(m, { x: (-spec.fx * base.width) / 2, y: (-spec.fy * base.height) / 2 });
    drag.current = {
      mode: 'scale',
      handle: handle.id,
      layerId: layer.id,
      fixed,
      axisX,
      axisY,
      base,
      transform: { ...layer.transform },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const state = store.getState();

    if (d.mode === 'pan') {
      state.setViewport({
        panX: d.panX + (e.clientX - d.startX),
        panY: d.panY + (e.clientY - d.startY),
        autoFit: false,
      });
      return;
    }

    const p = toCanvas(e);

    if (d.mode === 'paint') {
      // Coalesced events give the full sub-frame path on a high-rate pointer, which is what
      // keeps a fast stroke smooth instead of sampling it at 60Hz and cutting corners.
      const raw = typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : [e.nativeEvent];
      const points: StrokePoint[] = raw.map((ev) => {
        const q = toCanvas(ev);
        return { x: q.x, y: q.y, p: ev.pointerType === 'pen' ? Math.max(0.01, ev.pressure) : 1 };
      });
      if (points.length === 0) return;
      // The command APPENDS, so only the new points go out. Sending the whole path each move
      // would be O(n²) over a long stroke.
      state.dispatch(extendStroke(d.layerId, d.target, d.strokeId, d.brush, points));
      return;
    }

    if (d.mode === 'gradient') {
      state.dispatch(drawGradient(d.layerId, d.target, d.opId, d.from, p, d.fill, d.shape));
      return;
    }

    if (d.mode === 'marquee') {
      const current = e.shiftKey ? square(d.start, p) : p;
      drag.current = { ...d, current };
      const rect = rectBetween(d.start, current);
      setPreview(rect);
      state.dispatch(
        addSelectionRegion(
          d.ellipse
            ? ellipseRegion(rect.x, rect.y, rect.width, rect.height, d.combine)
            : rectRegion(rect.x, rect.y, rect.width, rect.height, d.combine),
          d.dragId,
        ),
      );
      return;
    }

    if (d.mode === 'lasso') {
      // Thin the path as it is captured: a lasso at 240Hz produces thousands of points that all
      // land inside one screen pixel, and every one of them would be serialized into the
      // document and re-traced on every render.
      const last = d.points[d.points.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2 / zoom) return;
      const points = [...d.points, p];
      drag.current = { ...d, points };
      if (points.length >= 3) {
        state.dispatch(addSelectionRegion(pathRegion([points], d.combine), d.dragId));
      }
      return;
    }

    if (d.mode === 'crop' || d.mode === 'draw') {
      // Shift constrains to a square, which for the crop tool is the only way to hit an exact
      // 1:1 by hand.
      const current = e.shiftKey ? square(d.start, p) : p;
      drag.current = { ...d, current };
      setPreview(rectBetween(d.start, current));
      return;
    }

    if (d.mode === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      // Shift locks to the dominant axis — measured on the TOTAL delta, not the incremental
      // one, or a slow diagonal drag would flip axes every few pixels.
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let nextGuides: SnapGuide[] = [];
      if (snapping && !e.altKey) {
        // Tolerance is a SCREEN distance, so it converts by zoom here and nowhere else.
        const snapped = snapMove(d.box, { dx, dy }, doc, new Set(d.ids), SNAP_TOLERANCE_PX / zoom);
        dx = snapped.dx;
        dy = snapped.dy;
        nextGuides = snapped.guides;
      }
      for (const id of d.ids) {
        const origin = d.origins.get(id);
        if (!origin) continue;
        state.dispatch(setLayerTransform(id, { x: origin.x + dx, y: origin.y + dy }));
      }
      setGuides(nextGuides);
      drag.current = { ...d, moved: true };
      return;
    }

    if (d.mode === 'rotate') {
      const angle = Math.atan2(p.y - d.centre.y, p.x - d.centre.x);
      let deg = d.startRotation + ((angle - d.startAngle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      state.dispatch(setLayerTransform(d.layerId, { rotation: normalizeDegrees(deg) }));
      return;
    }

    if (d.mode === 'scale') {
      const spec = HANDLES.find((h) => h.id === d.handle)!;
      const v = sub(p, d.fixed);
      // Project the drag onto the layer's own axes, so scaling a rotated layer stretches it
      // along ITS width rather than the screen's.
      let width = spec.fx === 0 ? d.base.width * d.transform.scaleX : dot(v, d.axisX) * spec.fx;
      let height = spec.fy === 0 ? d.base.height * d.transform.scaleY : dot(v, d.axisY) * spec.fy;

      // Corner + Shift keeps the aspect ratio; the axis that moved further wins so the box
      // follows the cursor rather than fighting it.
      if (e.shiftKey && spec.fx !== 0 && spec.fy !== 0) {
        const k = Math.max(width / d.base.width, height / d.base.height);
        width = d.base.width * k;
        height = d.base.height * k;
      }

      const scaleX = clampScale(width / d.base.width);
      const scaleY = clampScale(height / d.base.height);
      // Keep the opposite corner pinned: the new centre sits half a (new) box away from the
      // fixed point along each axis. For an edge handle that axis's sign is 0, so the centre
      // does not move on it — which is exactly what dragging one edge should do.
      const centre = add(
        d.fixed,
        add(
          mul(d.axisX, (spec.fx * d.base.width * scaleX) / 2),
          mul(d.axisY, (spec.fy * d.base.height * scaleY) / 2),
        ),
      );
      const patch = centreToTransform(centre, { ...d.transform, scaleX, scaleY }, d.base, doc);
      state.dispatch(setLayerTransform(d.layerId, { scaleX, scaleY, ...patch }));
      return;
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    const state = store.getState();

    // A selection drag that never moved is a click on empty space: deselect, which is what
    // every editor does and the only way to clear a marquee without reaching for a menu.
    if (d?.mode === 'marquee' && d.start.x === d.current.x && d.start.y === d.current.y) {
      if (d.combine === 'replace') state.dispatch(deselect());
      setPreview(null);
      return;
    }
    if (d?.mode === 'lasso' && d.points.length < 3) {
      if (d.combine === 'replace') state.dispatch(deselect());
      return;
    }

    if (d?.mode === 'crop' && preview) {
      if (preview.width > 4 && preview.height > 4) state.dispatch(cropCanvas(preview));
      state.setTool('move');
      state.fitToWindow();
    } else if (d?.mode === 'draw' && preview) {
      if (preview.width > 4 && preview.height > 4) {
        state.dispatch(
          addShapeLayer(shapeKind, {
            // The command scales presets for the canvas, so pass sizes it will not rescale:
            // dividing by the same factor keeps a hand-drawn box exactly the size it was drawn.
            width: preview.width / presetScale(doc),
            height: preview.height / presetScale(doc),
            at: {
              x: preview.x + preview.width / 2 - doc.width / 2,
              y: preview.y + preview.height / 2 - doc.height / 2,
            },
          }),
        );
        // Fresh read, for the same reason as the text tool above: `state` predates the dispatch.
        const added = store.getState().doc.layers.at(-1);
        if (added) state.selectLayer(added.id, 'replace');
        state.setTool('move');
      }
    }
    setPreview(null);
  };

  const onDoubleClick = (e: React.PointerEvent | React.MouseEvent) => {
    const p = toCanvas(e);
    const hit = hitTestDeep(p, doc);
    if (!hit) return;
    const state = store.getState();
    state.selectLayer(hit.id, 'replace');
    if (isTextLayer(hit)) state.setEditingText(hit.id);
  };

  // ── Drag & drop images ────────────────────────────────────────────────────

  const [dropping, setDropping] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) void store.getState().importFiles(files);
  };

  const selectedLayers = useMemo(
    () => selection.map((id) => findIn(doc, id)).filter((l): l is Layer => !!l),
    [selection, doc],
  );

  // Re-traced only when the selection itself changes, not on every render — the trace
  // rasterizes a bitmap, which is far too expensive to redo when a slider moved.
  const ants = useMemo(
    () => selectionOutline(doc.selection, { width: doc.width, height: doc.height }),
    [doc.selection, doc.width, doc.height],
  );
  const primary = selectedLayers.at(-1);
  const empty = doc.layers.length === 0;

  const cursor =
    spaceHeld || tool === 'hand' ? 'grab'
      : tool === 'text' ? 'text'
        // Every tool that draws by dragging out a region gets the crosshair, which is the one
        // cursor that says "the point matters" rather than "the object under you matters".
        : tool === 'crop' || tool === 'shape' || isPaintTool(tool) || isSelectTool(tool) ? 'crosshair'
          : 'default';

  return (
    <div
      ref={viewRef}
      className={`oc-stage${dropping ? ' oc-stage--dropping' : ''}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {showRulers && <Rulers doc={doc} zoom={zoom} panX={panX} panY={panY} />}

      <div
        ref={docRef}
        className="oc-stage__doc"
        style={{
          width: doc.width,
          height: doc.height,
          // translate BEFORE scale so pan stays in screen pixels, which is what the wheel
          // handler's zoom-at-cursor correction assumes.
          transform: `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${zoom})`,
        }}
      >
        <div className="oc-stage__checker" />
        <canvas ref={canvasRef} className="oc-stage__canvas" />

        <svg
          className="oc-stage__overlay"
          viewBox={`0 0 ${doc.width} ${doc.height}`}
          width={doc.width}
          height={doc.height}
        >
          {guides.map((g, i) => (
            <line
              key={i}
              className={`oc-guide oc-guide--${g.kind}`}
              x1={g.axis === 'x' ? g.at : 0}
              y1={g.axis === 'x' ? 0 : g.at}
              x2={g.axis === 'x' ? g.at : doc.width}
              y2={g.axis === 'x' ? doc.height : g.at}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {tool === 'move' && selectedLayers.map((layer) => (
            <polygon
              key={layer.id}
              className="oc-selbox"
              points={cornersOf(layer, doc).map((p) => `${p.x},${p.y}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {primary && tool === 'move' && !editingTextId && (
            <SelectionHandles layer={primary} doc={doc} zoom={zoom} />
          )}

          {/*
            Marching ants: two coincident strokes, black under white dashes, so the boundary
            stays visible over both light and dark artwork. The dash animation lives in CSS.
          */}
          {ants && (
            <g className="oc-ants">
              <path d={ants.d} className="oc-ants__under" vectorEffect="non-scaling-stroke" />
              <path d={ants.d} className="oc-ants__over" vectorEffect="non-scaling-stroke" />
            </g>
          )}

          {polyPoints.length > 0 && (
            <g className="oc-poly">
              <polyline
                points={polyPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                vectorEffect="non-scaling-stroke"
              />
              {polyPoints.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={4 / zoom} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}

          {preview && tool !== 'select-rect' && tool !== 'select-ellipse' && (
            <rect
              className={`oc-marquee${tool === 'crop' ? ' oc-marquee--crop' : ''}`}
              x={preview.x}
              y={preview.y}
              width={preview.width}
              height={preview.height}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {editingTextId && <InlineTextEditor layerId={editingTextId} doc={doc} />}
      </div>

      {empty && (
        <div className="oc-stage__empty">
          <EmptyState
            icon={<ImagePlus size={26} />}
            title="Start with an image — or don't"
            hint="Drop a file here, paste from the clipboard, or add text and shapes to an empty canvas."
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection handles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eight scale handles plus a rotation ring.
 *
 * Drawn in canvas coordinates but sized in screen pixels (hence every `/ zoom`), so a handle is
 * grabbable at 10% zoom and doesn't swallow the artwork at 800%.
 */
function SelectionHandles({ layer, doc, zoom }: { layer: Layer; doc: PhotoDocument; zoom: number }) {
  const m = matrixOf(layer, doc);
  const base = baseSizeOf(layer, doc);
  const size = HANDLE_PX / zoom;
  return (
    <g className="oc-handles">
      {HANDLES.map((h) => {
        const p = applyMat(m, { x: (h.fx * base.width) / 2, y: (h.fy * base.height) / 2 });
        return (
          <rect
            key={h.id}
            className="oc-handle"
            x={p.x - size / 2}
            y={p.y - size / 2}
            width={size}
            height={size}
            rx={size * 0.25}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

/**
 * Which handle (if any) is under a canvas-space point.
 *
 * The rotation zone is the ring just OUTSIDE each corner — the same convention every design
 * tool uses, and the reason it needs no visible affordance of its own. Slop is generous
 * (1.6× the handle) because a handle that needs pixel precision at 12% zoom is a handle nobody
 * can grab.
 */
function handleUnder(
  p: Point,
  layer: Layer | undefined,
  doc: PhotoDocument,
  zoom: number,
): { id: HandleId; rotate: boolean } | null {
  if (!layer) return null;
  const m = matrixOf(layer, doc);
  const base = baseSizeOf(layer, doc);
  const slop = (HANDLE_PX * 1.6) / zoom;
  const ring = ROTATE_RING_PX / zoom;

  for (const h of HANDLES) {
    const at = applyMat(m, { x: (h.fx * base.width) / 2, y: (h.fy * base.height) / 2 });
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= slop) return { id: h.id, rotate: false };
  }
  for (const h of HANDLES) {
    if (h.fx === 0 || h.fy === 0) continue; // corners only rotate
    const at = applyMat(m, { x: (h.fx * base.width) / 2, y: (h.fy * base.height) / 2 });
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= ring) return { id: h.id, rotate: true };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline text editing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A transparent textarea laid exactly over the rendered text.
 *
 * The glyphs the user sees are the GPU's — with their real stroke, shadow and gradient — while
 * the caret and selection come from a native textarea sitting on top with `color: transparent`.
 * That is what makes typing feel direct without reimplementing text rendering in the DOM, which
 * would inevitably disagree with the rasterizer about wrapping and letter spacing.
 *
 * The positioning matrix is composed from the SAME layer matrix the renderer uses, offset to
 * the text block's top-left inside its (bleed-padded) raster. So it stays glued to the text
 * under rotation, scale and flips instead of approximating with a bounding box.
 */
function InlineTextEditor({ layerId, doc }: { layerId: LayerId; doc: PhotoDocument }) {
  const store = usePhotoStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = findIn(doc, layerId);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [layerId]);

  if (!layer || !isTextLayer(layer)) return null;
  const style = layer.style;
  const layout = layoutText(layer);
  const m = matrixOf(layer, doc);
  // Local (0,0) is the raster's centre; the text block's top-left is half a block away.
  const placed = matMul(m, { a: 1, b: 0, c: 0, d: 1, e: -layout.blockWidth / 2, f: -layout.blockHeight / 2 });

  return (
    <textarea
      ref={ref}
      className="oc-textedit"
      value={layer.content}
      spellCheck={false}
      style={{
        width: layout.blockWidth,
        height: layout.blockHeight,
        transform: `matrix(${placed.a}, ${placed.b}, ${placed.c}, ${placed.d}, ${placed.e}, ${placed.f})`,
        font: cssFont(style),
        lineHeight: `${layout.lineHeight}px`,
        letterSpacing: `${style.letterSpacing}px`,
        textAlign: style.align,
        textTransform: style.transform === 'none' ? 'none' : style.transform,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => store.getState().dispatch(setTextContent(layerId, e.target.value))}
      onKeyDown={(e) => {
        // Escape and Ctrl/Cmd+Enter both commit. Plain Enter must NOT — a headline on three
        // lines is the normal case, and stealing Enter would make it impossible to type.
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          store.getState().setEditingText(null);
        }
        e.stopPropagation(); // keep editor keystrokes away from the global shortcuts
      }}
      onBlur={() => store.getState().setEditingText(null)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rulers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rulers along the top and left, in document pixels.
 *
 * The tick interval is chosen so labels stay roughly 80 screen pixels apart at any zoom — a
 * fixed interval either crowds into unreadable mush when zoomed out or shows three ticks when
 * zoomed in.
 */
function Rulers({ doc, zoom, panX, panY }: { doc: PhotoDocument; zoom: number; panX: number; panY: number }) {
  const step = niceStep(80 / zoom);
  const ticks = (extent: number) => {
    const out: number[] = [];
    for (let v = 0; v <= extent; v += step) out.push(v);
    return out;
  };
  return (
    <>
      <div className="oc-ruler oc-ruler--h">
        <div className="oc-ruler__inner" style={{ transform: `translateX(calc(50% + ${panX}px))` }}>
          {ticks(doc.width).map((v) => (
            <span key={v} className="oc-ruler__tick" style={{ left: (v - doc.width / 2) * zoom }}>
              {v}
            </span>
          ))}
        </div>
      </div>
      <div className="oc-ruler oc-ruler--v">
        <div className="oc-ruler__inner" style={{ transform: `translateY(calc(50% + ${panY}px))` }}>
          {ticks(doc.height).map((v) => (
            <span key={v} className="oc-ruler__tick" style={{ top: (v - doc.height / 2) * zoom }}>
              {v}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/** 1/2/5 × 10ⁿ — the interval sequence that reads as "round numbers" at every scale. */
function niceStep(target: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
  for (const mult of [1, 2, 5, 10]) if (pow * mult >= target) return pow * mult;
  return pow * 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A layer scaled to exactly 0 has no inverse and no grabbable box — never let it get there. */
const clampScale = (v: number) => (Math.abs(v) < 0.01 ? (v < 0 ? -0.01 : 0.01) : clamp(v, -50, 50));
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const centroid = (ps: readonly Point[]): Point => ({
  x: ps.reduce((n, p) => n + p.x, 0) / ps.length,
  y: ps.reduce((n, p) => n + p.y, 0) / ps.length,
});

const rectBetween = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

/** Constrain `b` so the rectangle from `a` is square, keeping the direction of the drag. */
function square(a: Point, b: Point): Point {
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
}

const normalizeDegrees = (deg: number): number => {
  const d = ((deg + 180) % 360 + 360) % 360 - 180;
  return Math.round(d * 10) / 10;
};

/** The layer's un-scaled drawn size — what the handles are laid out on. */
function baseSizeOf(layer: Layer, doc: PhotoDocument) {
  const natural = naturalSizeOf(layer, doc);
  const canvas = { width: doc.width, height: doc.height };
  if (fitModeOf(layer) === 'exact') return natural;
  if (!natural.width || !natural.height) return canvas;
  const canvasAspect = canvas.width / canvas.height;
  const srcAspect = natural.width / natural.height;
  return srcAspect > canvasAspect
    ? { width: canvas.width, height: canvas.width / srcAspect }
    : { width: canvas.height * srcAspect, height: canvas.height };
}

/**
 * Solve for the `x`/`y` that put a layer's centre at `centre`.
 *
 * `layerMatrix` maps local (0,0) to `(canvas/2 + t) + a - R·S·F·a`, where `a` is the anchor
 * offset. With the default centre anchor that reduces to `canvas/2 + t` and this is a
 * subtraction — but the anchor is a real, honored field, so the general form is what is
 * implemented. Getting this wrong makes a scale drag on an off-centre-anchored layer creep.
 */
function centreToTransform(
  centre: Point,
  transform: Transform2D,
  base: { width: number; height: number },
  doc: PhotoDocument,
): { x: number; y: number } {
  const ax = base.width * (transform.anchorX - 0.5);
  const ay = base.height * (transform.anchorY - 0.5);
  const rad = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const fx = transform.scaleX * (transform.flipH ? -1 : 1);
  const fy = transform.scaleY * (transform.flipV ? -1 : 1);
  // R · S · F applied to (ax, ay).
  const rx = cos * (fx * ax) - sin * (fy * ay);
  const ry = sin * (fx * ax) + cos * (fy * ay);
  return {
    x: centre.x - doc.width / 2 - ax + rx,
    y: centre.y - doc.height / 2 - ay + ry,
  };
}

/** Presets are authored for a 1280px canvas; mirrors `vectorCommands`' own scaling. */
const presetScale = (doc: PhotoDocument) => Math.max(0.15, Math.min(6, doc.width / 1280));

/** Find a layer anywhere in the document's tree. */
function findIn(doc: PhotoDocument, id: LayerId): Layer | undefined {
  const visit = (layers: readonly Layer[]): Layer | undefined => {
    for (const l of layers) {
      if (l.id === id) return l;
      if (l.kind === 'group') {
        const found = visit(l.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(doc.layers);
}

/** True when a key event came from a field the user is typing into. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
};
