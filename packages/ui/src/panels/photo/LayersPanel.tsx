/**
 * LayersPanel — the layer tree.
 *
 * Renders the document's TREE top-first: the model stores bottom-to-top (matching core's Track
 * convention) but every layers panel in every editor reads top-down, because that is the order
 * the pixels stack.
 *
 * Two things it deliberately does properly rather than approximately:
 *
 *   • **Drag and drop reparents, not just reorders.** Dropping on the top or bottom third of a
 *     row inserts beside it; dropping on the middle of a *group* drops inside it. That third
 *     case is what makes folders usable, and it is the one every simplified implementation
 *     leaves out.
 *
 *   • **Thumbnails are real.** A shape's thumbnail is its actual path, a text layer's is its
 *     actual font. A row of identical generic icons is a list of names with extra steps.
 */

import { useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Lock,
  Plus,
  SlidersHorizontal,
  Trash2,
  Unlock,
} from 'lucide-react';
import { allEffects, getEffectDef } from '@opencut/core';
import {
  addAdjustmentLayer,
  deleteLayer,
  duplicateLayer,
  groupSelection,
  isGroupLayer,
  isShapeLayer,
  isTextLayer,
  moveLayer,
  parentOf,
  pathBounds,
  renameLayer,
  setGroupCollapsed,
  setLayerClipped,
  setLayerLocked,
  setLayerVisible,
  shapePath,
  ungroup,
  type Layer,
  type LayerId,
  type PhotoDocument,
} from '@opencut/photo';
import { EmptyState, IconButton } from '../../components/primitives/index.js';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';

type DropZone = 'above' | 'below' | 'inside';

export function LayersPanel() {
  const store = usePhotoStore();
  const doc = usePhoto((s) => s.doc);
  const selection = usePhoto((s) => s.selection);
  const [adding, setAdding] = useState(false);
  const dragId = useRef<LayerId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: LayerId; zone: DropZone } | null>(null);

  const adjustments = useMemo(
    () => allEffects().filter((d) => d.category === 'color' || d.category === 'light' || d.category === 'stylize'),
    [],
  );

  const onDrop = (target: Layer, zone: DropZone) => {
    const sourceId = dragId.current;
    dragId.current = null;
    setDropTarget(null);
    if (!sourceId || sourceId === target.id) return;

    if (zone === 'inside' && isGroupLayer(target)) {
      // MAX_SAFE_INTEGER clamps to the end, which is the top of the group's stack — where a
      // dropped layer should land, since the panel shows it as the group's first row.
      store.getState().dispatch(moveLayer(sourceId, target.id, Number.MAX_SAFE_INTEGER));
      return;
    }
    const parent = parentOf(doc.layers, target.id);
    const siblings = parent && isGroupLayer(parent) ? parent.children : doc.layers;
    const index = siblings.findIndex((l) => l.id === target.id);
    if (index === -1) return;
    // The panel is top-first, so "above" in the UI is a HIGHER index in the model.
    store.getState().dispatch(moveLayer(sourceId, parent?.id ?? null, zone === 'above' ? index + 1 : index));
  };

  return (
    <div className="oc-layers">
      <div className="oc-layers__tools">
        <IconButton title="Add adjustment layer" onClick={() => setAdding((v) => !v)} active={adding}>
          <Plus size={15} />
        </IconButton>
        <IconButton
          title="Group selection"
          disabled={selection.length < 2}
          onClick={() => store.getState().dispatch(groupSelection(selection))}
        >
          <FolderPlus size={15} />
        </IconButton>
        <div className="oc-layers__spacer" />
        <IconButton
          title="Duplicate"
          disabled={selection.length === 0}
          onClick={() => selection.forEach((id) => store.getState().dispatch(duplicateLayer(id)))}
        >
          <Copy size={15} />
        </IconButton>
        <IconButton
          title="Delete"
          disabled={selection.length === 0}
          onClick={() => selection.forEach((id) => store.getState().dispatch(deleteLayer(id)))}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>

      {/*
        Adjustment layers are offered from the LAYERS panel, not the effect rack, because that is
        what they are: a layer that re-colours everything beneath it. Putting them with the
        effects would imply they belong to the selected layer, which is the one thing they
        specifically do not do.
      */}
      {adding && (
        <div className="oc-picker">
          <div className="oc-picker__list">
            {adjustments.map((def) => (
              <button
                key={def.type}
                className="oc-picker__item"
                onClick={() => {
                  store.getState().dispatch(addAdjustmentLayer(def.type));
                  const added = store.getState().doc.layers.at(-1);
                  if (added) store.getState().selectLayer(added.id, 'replace');
                  setAdding(false);
                }}
              >
                <span>{def.label}</span>
                <span className="oc-picker__cat">{def.category}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {doc.layers.length === 0 ? (
        <EmptyState icon={<ImageIcon size={22} />} title="No layers" hint="Add an image, text or a shape." />
      ) : (
        <div className="oc-layers__list">
          <LayerList
            layers={doc.layers}
            doc={doc}
            selection={selection}
            depth={0}
            dragId={dragId}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            onDrop={onDrop}
          />
        </div>
      )}
    </div>
  );
}

interface ListProps {
  layers: readonly Layer[];
  doc: PhotoDocument;
  selection: readonly LayerId[];
  depth: number;
  dragId: React.MutableRefObject<LayerId | null>;
  dropTarget: { id: LayerId; zone: DropZone } | null;
  setDropTarget: (t: { id: LayerId; zone: DropZone } | null) => void;
  onDrop: (target: Layer, zone: DropZone) => void;
}

/** Recursive: renders one sibling list top-first, descending into open groups. */
function LayerList(props: ListProps) {
  const { layers, depth } = props;
  return (
    <>
      {[...layers].reverse().map((layer) => (
        <div key={layer.id}>
          <LayerRow {...props} layer={layer} />
          {isGroupLayer(layer) && !layer.collapsed && layer.children.length > 0 && (
            <LayerList {...props} layers={layer.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}

function LayerRow({ layer, doc, selection, depth, dragId, dropTarget, setDropTarget, onDrop }: ListProps & { layer: Layer }) {
  const store = usePhotoStore();
  const [renaming, setRenaming] = useState(false);
  const selected = selection.includes(layer.id);
  const drop = dropTarget?.id === layer.id ? dropTarget.zone : null;

  const zoneFor = (e: React.DragEvent): DropZone => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = (e.clientY - rect.top) / rect.height;
    if (isGroupLayer(layer) && t > 0.3 && t < 0.7) return 'inside';
    return t < 0.5 ? 'above' : 'below';
  };

  return (
    <div
      className={[
        'oc-layer',
        selected && 'oc-layer--selected',
        layer.clipped && 'oc-layer--clipped',
        !layer.visible && 'oc-layer--hidden',
        drop && `oc-layer--drop-${drop}`,
      ].filter(Boolean).join(' ')}
      style={{ paddingLeft: 6 + depth * 14 }}
      draggable
      onDragStart={() => (dragId.current = layer.id)}
      onDragEnd={() => {
        dragId.current = null;
        setDropTarget(null);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (dragId.current && dragId.current !== layer.id) setDropTarget({ id: layer.id, zone: zoneFor(e) });
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(layer, zoneFor(e));
      }}
      onClick={(e) => store.getState().selectLayer(layer.id, e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')}
    >
      {isGroupLayer(layer) ? (
        <button
          className="oc-layer__twisty"
          title={layer.collapsed ? 'Expand' : 'Collapse'}
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(setGroupCollapsed(layer.id, !layer.collapsed));
          }}
        >
          {layer.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span className="oc-layer__twisty" />
      )}

      <button
        className="oc-layer__eye"
        title={layer.visible ? 'Hide' : 'Show'}
        onClick={(e) => {
          e.stopPropagation();
          store.getState().dispatch(setLayerVisible(layer.id, !layer.visible));
        }}
      >
        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

      <Thumbnail layer={layer} doc={doc} />

      {layer.clipped && <CornerDownRight size={12} className="oc-layer__clipmark" />}

      {renaming ? (
        <input
          className="oc-layer__rename"
          autoFocus
          defaultValue={layer.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            store.getState().dispatch(renameLayer(layer.id, e.target.value.trim() || layer.name));
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span
          className="oc-layer__name"
          title={layer.name}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setRenaming(true);
          }}
        >
          {layer.name}
        </span>
      )}

      {layer.effects.length > 0 && (
        <span className="oc-layer__badge" title={layer.effects.map((f) => getEffectDef(f.type)?.label ?? f.type).join(', ')}>
          {layer.effects.length}
        </span>
      )}
      {Math.round(layer.opacity * 100) < 100 && (
        <span className="oc-layer__badge oc-layer__badge--dim">{Math.round(layer.opacity * 100)}%</span>
      )}

      {isGroupLayer(layer) && (
        <IconButton
          size="sm"
          title="Ungroup"
          onClick={(e) => {
            e.stopPropagation();
            store.getState().dispatch(ungroup(layer.id));
          }}
        >
          <FolderOpen size={13} />
        </IconButton>
      )}
      <IconButton
        size="sm"
        title={layer.clipped ? 'Release clipping mask' : 'Clip to layer below'}
        active={layer.clipped}
        onClick={(e) => {
          e.stopPropagation();
          store.getState().dispatch(setLayerClipped(layer.id, !layer.clipped));
        }}
      >
        <CornerDownRight size={13} />
      </IconButton>
      <IconButton
        size="sm"
        title={layer.locked ? 'Unlock' : 'Lock'}
        onClick={(e) => {
          e.stopPropagation();
          store.getState().dispatch(setLayerLocked(layer.id, !layer.locked));
        }}
      >
        {layer.locked ? <Lock size={13} /> : <Unlock size={13} />}
      </IconButton>
    </div>
  );
}

/**
 * A real preview of the layer.
 *
 * Shapes get their actual path as an inline SVG, text gets its actual font and fill, images get
 * the image. That is worth the extra code: a layers panel is a *visual* index, and a column of
 * identical icons makes it a text list that happens to have pictures next to it.
 */
function Thumbnail({ layer, doc }: { layer: Layer; doc: PhotoDocument }) {
  const store = usePhotoStore();

  if (isGroupLayer(layer)) {
    return (
      <span className="oc-layer__thumb oc-layer__thumb--icon">
        {layer.collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
      </span>
    );
  }
  if (layer.kind === 'adjustment') {
    return (
      <span className="oc-layer__thumb oc-layer__thumb--icon">
        <SlidersHorizontal size={14} />
      </span>
    );
  }
  if (isTextLayer(layer)) {
    const fill = layer.style.fill.kind === 'solid' ? layer.style.fill.color : layer.style.fill.stops[0]?.color;
    return (
      <span
        className="oc-layer__thumb oc-layer__thumb--text"
        style={{ fontFamily: layer.style.fontFamily, fontWeight: layer.style.fontWeight, color: fill }}
      >
        Aa
      </span>
    );
  }
  if (isShapeLayer(layer)) {
    const path = shapePath(layer.shape, layer.width, layer.height, layer.params);
    const b = pathBounds(path);
    const fill = layer.fill.kind === 'solid' ? layer.fill.color : layer.fill.stops[0]?.color ?? 'none';
    return (
      <span className="oc-layer__thumb">
        <svg viewBox={`${b.x} ${b.y} ${Math.max(1, b.w)} ${Math.max(1, b.h)}`} width="20" height="20">
          {/* Stroke width is in the shape's OWN units, which the viewBox already scales down to
              20px. `non-scaling-stroke` would instead pin it to screen pixels — so a 10px
              outline drew a 10px band on a 20px thumbnail and swallowed the shape whole. */}
          <path
            d={toSvgPath(path)}
            fill={fill}
            stroke={layer.stroke?.color ?? 'none'}
            strokeWidth={layer.stroke ? Math.max(b.w, b.h) * 0.05 : 0}
          />
        </svg>
      </span>
    );
  }
  // Image: resolve through the bridge, exactly as the renderer does.
  const media = layer.mediaId ? doc.media.find((m) => m.id === layer.mediaId) : undefined;
  if (!media) return <span className="oc-layer__thumb oc-layer__thumb--icon"><ImageIcon size={14} /></span>;
  return (
    <span className="oc-layer__thumb">
      <img src={store.getState().bridge.resolveMediaUrl(media.src)} alt="" />
    </span>
  );
}

/** Path commands → an SVG `d` string. The same commands the rasterizer replays into a canvas. */
function toSvgPath(cmds: ReturnType<typeof shapePath>): string {
  return cmds
    .map((c) =>
      c.c === 'M' ? `M${c.x} ${c.y}`
        : c.c === 'L' ? `L${c.x} ${c.y}`
          : c.c === 'C' ? `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`
            : 'Z',
    )
    .join(' ');
}
