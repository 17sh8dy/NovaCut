/**
 * AssetsPanel — the creator toolkit.
 *
 * One click from "I need a red arrow" to a red arrow on the canvas. Everything here is a
 * shortcut past a sequence the user would otherwise have to perform: add shape, pick arrow,
 * pick red, add a white outline, add a shadow, resize. That sequence is not creative work, it
 * is typing, and this panel is the argument that an editor's job is to delete it.
 *
 * The presets are DATA (`@opencut/photo`'s `presets.ts`), not code here, so a user-editable
 * library is a serialization away rather than a rewrite.
 */

import { useState } from 'react';
import { Search, Shapes, Smile, Sparkles, Type } from 'lucide-react';
import {
  SHAPE_KINDS,
  SHAPE_LABELS,
  SHAPE_PRESETS,
  STICKER_EMOJI,
  TEXT_PRESETS,
  addShapeLayer,
  addTextLayer,
  pathBounds,
  shapePath,
  DEFAULT_SHAPE_PARAMS,
  type ShapeKind,
} from '@opencut/photo';
import { usePhoto, usePhotoStore } from '../../state/photoContext.js';
import { Section } from './controls.js';

export function AssetsPanel() {
  const store = usePhotoStore();
  const shapeKind = usePhoto((s) => s.shapeKind);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  const add = (fn: () => void) => {
    fn();
    const added = store.getState().doc.layers.at(-1);
    if (added) store.getState().selectLayer(added.id, 'replace');
  };

  return (
    <div className="oc-assets">
      <div className="oc-picker__search oc-assets__search">
        <Search size={14} />
        <input placeholder="Search assets" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <Section title="Quick Assets" icon={<Sparkles size={14} />}>
        <div className="oc-tiles">
          {SHAPE_PRESETS.filter((p) => match(p.label)).map((preset) => (
            <button
              key={preset.id}
              className="oc-tile"
              title={preset.label}
              onClick={() =>
                add(() =>
                  store.getState().dispatch(
                    addShapeLayer(preset.kind, {
                      name: preset.label,
                      width: preset.width,
                      height: preset.height,
                      fill: preset.fill,
                      stroke: preset.stroke,
                      shadow: preset.shadow,
                      glow: preset.glow,
                      params: preset.params,
                    }),
                  ),
                )
              }
            >
              <ShapeGlyph
                kind={preset.kind}
                fill={preset.fill.kind === 'solid' ? preset.fill.color : preset.fill.stops[0]?.color ?? '#fff'}
                stroke={preset.stroke?.color}
              />
              <span>{preset.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Shapes" icon={<Shapes size={14} />}>
        <div className="oc-tiles oc-tiles--compact">
          {SHAPE_KINDS.filter((k) => match(SHAPE_LABELS[k])).map((kind) => (
            <button
              key={kind}
              className="oc-tile"
              title={SHAPE_LABELS[kind]}
              data-active={kind === shapeKind}
              onClick={() => {
                // Sets the shape tool's kind AND drops one on the canvas. Picking a shape then
                // having to also drag it out is a step nobody wants twice.
                store.getState().setShapeKind(kind);
                add(() => store.getState().dispatch(addShapeLayer(kind, { name: SHAPE_LABELS[kind] })));
              }}
            >
              <ShapeGlyph kind={kind} fill="var(--text-secondary)" />
              <span>{SHAPE_LABELS[kind]}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Text Styles" icon={<Type size={14} />}>
        <div className="oc-presets">
          {TEXT_PRESETS.filter((p) => match(p.label)).map((preset) => (
            <button
              key={preset.id}
              className="oc-preset"
              title={preset.label}
              onClick={() => add(() => store.getState().dispatch(addTextLayer(preset.sample ?? 'Your text', preset.style)))}
            >
              <span
                className="oc-preset__sample"
                style={{
                  fontFamily: preset.style.fontFamily,
                  fontWeight: preset.style.fontWeight,
                  fontStyle: preset.style.italic ? 'italic' : undefined,
                  textTransform: preset.style.transform === 'uppercase' ? 'uppercase' : undefined,
                }}
              >
                {preset.sample ?? 'Aa'}
              </span>
              <span className="oc-preset__label">{preset.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Stickers" icon={<Smile size={14} />}>
        {/*
          Emoji rather than bundled artwork: every platform ships a full colour emoji font, so
          these render exactly as the audience will see them elsewhere, weigh nothing, and never
          go stale. Inserted as ordinary TEXT layers, which means every text control — stroke,
          shadow, glow, curve — works on them for free.
        */}
        <div className="oc-emoji">
          {STICKER_EMOJI.map((emoji) => (
            <button
              key={emoji}
              className="oc-emoji__item"
              onClick={() =>
                add(() =>
                  store.getState().dispatch(
                    addTextLayer(emoji, { fontSize: 220, stroke: null, shadow: null, glow: null }),
                  ),
                )
              }
            >
              {emoji}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** A tiny preview of a shape kind, drawn from the same path function the rasterizer uses. */
function ShapeGlyph({ kind, fill, stroke }: { kind: ShapeKind; fill: string; stroke?: string }) {
  const path = shapePath(kind, 100, 70, DEFAULT_SHAPE_PARAMS);
  const b = pathBounds(path);
  const d = path
    .map((c) =>
      c.c === 'M' ? `M${c.x} ${c.y}`
        : c.c === 'L' ? `L${c.x} ${c.y}`
          : c.c === 'C' ? `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`
            : 'Z',
    )
    .join(' ');
  return (
    <svg
      className="oc-tile__glyph"
      viewBox={`${b.x - 4} ${b.y - 4} ${Math.max(1, b.w) + 8} ${Math.max(1, b.h) + 8}`}
    >
      {/* Stroke width is in the glyph's own 100×70 units, not screen pixels: `non-scaling-stroke`
          here would draw a band as thick as the whole preview. */}
      <path d={d} fill={fill} stroke={stroke ?? 'none'} strokeWidth={stroke ? 5 : 0} />
    </svg>
  );
}
