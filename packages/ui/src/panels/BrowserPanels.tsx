import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  addClipOnFreeTrack,
  allTools,
  createTextClip,
  instantiateEffect,
  updateClip,
  VIDEO_TEXT_PRESET_GROUPS,
  VIDEO_TEXT_PRESETS,
  type EffectCategory,
  type VideoTextPreset,
} from '@opencut/core';
import { EmptyState, Segmented } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { TextAnimationsPanel } from './browsers/TextAnimationsPanel.js';
import { TextEffectsPanel } from './browsers/TextEffectsPanel.js';
import {
  CategoryTabs,
  ItemChip,
  matches,
  NoResults,
  SearchBox,
  bucket,
  useShelfMemory,
} from './browsers/shared.js';

export { FiltersPanel } from './browsers/FiltersPanel.js';

const CATEGORY_LABEL: Record<EffectCategory, string> = {
  blur: 'Blur',
  stylize: 'Stylize',
  color: 'Color',
  light: 'Light',
  style: 'Layer Styles',
  distort: 'Distort',
  glitch: 'Glitch',
  time: 'Time',
};

/**
 * A small animated demo shown inside a chip's preview slot. It's a CSS approximation of the
 * effect/transition (not the real GPU output, which would be too heavy per chip) that plays on
 * hover — see `.oc-fx-demo` in panels.css. `demo` selects the animation.
 */
function FxPreview({ demo }: { demo: string }) {
  return (
    <div className="oc-fx-demo" data-demo={demo} aria-hidden>
      <span className="oc-fx-demo__fg" />
    </div>
  );
}

/**
 * Effects browser: the raw TOOLS, searchable and grouped by what they do to pixels.
 *
 * `allTools()` rather than `allEffects()` — filters are effects too, but they belong on the
 * Filters shelf, and dropping thirty finished looks into a list of adjustment tools is exactly
 * the "one giant list" this browser exists to avoid.
 */
export function EffectsPanel() {
  const store = useAppStore();
  const selectedId = useStore((s) => s.selectedClipIds[0]);
  const [tab, setTab] = useState<EffectCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const { favorites, recents, toggleFavorite, markUsed } = useShelfMemory('effects');

  const tools = useMemo(() => allTools(), []);
  const tabs = useMemo(
    () => [
      { value: 'all' as const, label: 'All' },
      ...[...new Set(tools.map((e) => e.category))].map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
    ],
    [tools],
  );

  const items = useMemo(
    () =>
      tools
        .filter((e) => tab === 'all' || e.category === tab)
        .filter((e) => matches(query, e.label, e.category, e.type)),
    [tools, tab, query],
  );
  const { favorite, recent, rest } = bucket(items, (e) => e.type, favorites, recents);

  const addEffect = (type: string) => {
    const id = selectedId;
    if (!id) return store.getState().notify('Select a clip first', 'info');
    const seq = store.getState().sequence();
    const instance = instantiateEffect(type);
    store.getState().dispatch({
      label: 'Add Effect',
      apply: (p) => updateClip(p, seq.id, id, (c) => ({ ...c, effects: [...c.effects, instance] })),
    });
    markUsed(type);
    store.getState().setInspectorTab('effects');
    store.getState().notify('Effect added', 'success');
  };

  const chip = (e: { type: string; label: string; category: EffectCategory }) => (
    <ItemChip
      key={e.type}
      label={e.label}
      title={`${e.label} — hover to preview, click to apply`}
      favorite={favorites.includes(e.type)}
      onToggleFavorite={() => toggleFavorite(e.type)}
      onClick={() => addEffect(e.type)}
    >
      <FxPreview demo={e.category} />
    </ItemChip>
  );

  return (
    <div className="oc-browser">
      <CategoryTabs tabs={tabs} value={tab} onChange={setTab} />
      <SearchBox value={query} onChange={setQuery} placeholder="Search effects" />
      <div className="oc-browser__scroll">
        {items.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <>
            <ChipRow title="Favourites" items={favorite} render={chip} />
            <ChipRow title="Recent" items={recent} render={chip} />
            <ChipRow
              title={favorite.length || recent.length ? 'All' : tabs.find((t) => t.value === tab)!.label}
              items={rest}
              render={chip}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** Local section helper — the shared one takes children; this one takes a render function. */
function ChipRow<T>({ title, items, render }: { title: string; items: T[]; render: (item: T) => React.ReactNode }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="oc-section-title">{title}</div>
      <div className="oc-chip-grid">{items.map(render)}</div>
    </div>
  );
}

export { TransitionsPanel } from './browsers/TransitionsPanel.js';

/**
 * The swatch previews a preset by rendering its ACTUAL style in CSS, at a size that fits the
 * chip — not an icon and not a screenshot. The mapping is deliberately the same set of
 * properties the rasterizer draws (fill/gradient, stroke, shadow, glow, background), so a chip
 * that looks wrong is telling the truth about the preset rather than about the preview.
 *
 * The one honest divergence: `-webkit-text-stroke` centres its line where the canvas rasterizer
 * strokes OUTSIDE, so heavy outlines read slightly thinner here than on the canvas.
 */
function TextPresetSwatch({ preset }: { preset: VideoTextPreset }) {
  const s = preset.style;
  const glow = s.glow ? `0 0 ${Math.round(s.glow.radius * 0.5)}px ${s.glow.color}` : '';
  const shadow = s.shadow ? `${s.shadow.x * 0.4}px ${s.shadow.y * 0.4}px ${s.shadow.blur * 0.4}px ${s.shadow.color}` : '';
  const textShadow = [glow, shadow].filter(Boolean).join(', ') || undefined;

  const gradientFill = s.gradient
    ? {
        backgroundImage: `linear-gradient(${s.gradient.angle}deg, ${s.gradient.from}, ${s.gradient.to})`,
        WebkitBackgroundClip: 'text' as const,
        backgroundClip: 'text' as const,
        color: 'transparent',
      }
    : { color: s.color };

  return (
    <span
      className="oc-textpreset__swatch"
      style={{
        fontFamily: s.fontFamily,
        fontWeight: s.fontWeight,
        fontStyle: s.italic ? 'italic' : 'normal',
        letterSpacing: Math.min(3, (s.letterSpacing ?? 0) * 0.5),
        ...gradientFill,
        textShadow,
        WebkitTextStroke: s.stroke && s.stroke.width > 0
          ? `${Math.max(0.5, s.stroke.width * 0.16)}px ${s.stroke.color}`
          : undefined,
        ...(s.background
          ? {
              background: s.background.color,
              padding: '2px 10px',
              borderRadius: Math.min(999, s.background.radius),
            }
          : null),
      }}
    >
      {preset.defaultContent}
    </span>
  );
}

/**
 * The Text browser, split three ways.
 *
 * Presets create a title; Animations and Effects change one that already exists. Keeping them
 * on one rail button but behind sub-tabs matches how the work actually goes — you add the
 * title, then animate it, then dress it — without making "Text" mean three different things
 * depending on which rail icon you remembered to press.
 */
export function TextPanel() {
  const [section, setSection] = useState<'presets' | 'animations' | 'effects'>('presets');
  return (
    <div className="oc-browser">
      <div className="oc-browser__sections">
        <Segmented
          options={[
            { value: 'presets' as const, label: 'Presets' },
            { value: 'animations' as const, label: 'Animations' },
            { value: 'effects' as const, label: 'Effects' },
          ]}
          value={section}
          onChange={setSection}
        />
      </div>
      {section === 'presets' && <TextPresetsPanel />}
      {section === 'animations' && <TextAnimationsPanel />}
      {section === 'effects' && <TextEffectsPanel />}
    </div>
  );
}

/**
 * Presets that drop a styled text clip on a free track — at the playhead on a click, or at
 * wherever it's dropped when dragged onto the timeline (see Timeline.tsx's Lane `onDrop`, the
 * `application/x-opencut-text` branch, which builds the clip the same way this does).
 */
function TextPresetsPanel() {
  const store = useAppStore();

  const addText = (preset: VideoTextPreset) => {
    // `store.playhead` is the live one. `Sequence.playhead` is a serialized field that nothing
    // updates during a session, so it reads 0 forever — which is why every text clip used to
    // land at the start of the timeline no matter where the playhead actually was. It looked
    // like "add text does nothing" whenever you were more than four seconds in.
    const clip = createTextClip(store.getState().playhead, preset.defaultContent);
    // Merge over the factory default rather than replacing it, so any field the preset has no
    // opinion on (alignment, underline) keeps a sane value instead of becoming undefined.
    if (clip.text) clip.text = { ...clip.text, ...preset.style, content: preset.defaultContent };
    clip.name = preset.label;
    // Never onto the footage track: the compositor draws one clip per track, so text has to
    // live above the video, not compete with it.
    store.getState().dispatch(addClipOnFreeTrack(clip));
    store.getState().selectClip(clip.id);
    store.getState().setInspectorTab('text');
  };

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      {VIDEO_TEXT_PRESET_GROUPS.map((group) => (
        <div key={group}>
          <div className="oc-section-title">{group}</div>
          <div className="oc-textpreset__list">
            {VIDEO_TEXT_PRESETS.filter((p) => p.group === group).map((p) => (
              <button
                key={p.id}
                className="oc-textpreset"
                onClick={() => addText(p)}
                title={`${p.label} — click to add at the playhead, or drag onto the timeline`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/x-opencut-text', p.id)}
              >
                <span className="oc-textpreset__stage">
                  <TextPresetSwatch preset={p} />
                </span>
                <span className="oc-textpreset__meta">
                  <span className="oc-textpreset__label">{p.label}</span>
                  {p.hint && <span className="oc-textpreset__hint">{p.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlaceholderPanel({ title, hint }: { title: string; hint: string }) {
  return <EmptyState icon={<Sparkles size={36} />} title={title} hint={hint} />;
}
