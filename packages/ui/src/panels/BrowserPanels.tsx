import { Sparkles } from 'lucide-react';
import {
  addClipOnFreeTrack,
  allEffects,
  allTransitions,
  createTextClip,
  instantiateEffect,
  updateClip,
  VIDEO_TEXT_PRESET_GROUPS,
  VIDEO_TEXT_PRESETS,
  type EffectCategory,
  type VideoTextPreset,
} from '@opencut/core';
import { EmptyState } from '../components/primitives/index.js';
import { applyTransitionAtTime } from './Timeline.js';
import { useAppStore, useStore } from '../state/context.js';

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

/** Map a transition type to the closest demo animation. */
function transitionDemo(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('zoom')) return 'zoom';
  if (t.includes('slide') || t.includes('push') || t.includes('wipe')) return 'slide';
  if (t.includes('glitch')) return 'glitch';
  if (t.includes('spin') || t.includes('rotate')) return 'distort';
  return 'fade';
}

/** Effects browser: grouped catalog; clicking adds the effect to the selected clip. */
export function EffectsPanel() {
  const store = useAppStore();
  const selectedId = useStore((s) => s.selectedClipIds[0]);
  const effects = allEffects();
  const categories = [...new Set(effects.map((e) => e.category))];

  const addEffect = (type: string) => {
    const id = selectedId;
    if (!id) return store.getState().notify('Select a clip first', 'info');
    const seq = store.getState().sequence();
    const instance = instantiateEffect(type);
    store.getState().dispatch({
      label: 'Add Effect',
      apply: (p) => updateClip(p, seq.id, id, (c) => ({ ...c, effects: [...c.effects, instance] })),
    });
    store.getState().setInspectorTab('effects');
    store.getState().notify('Effect added', 'success');
  };

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      {categories.map((cat) => (
        <div key={cat}>
          <div className="oc-section-title">{CATEGORY_LABEL[cat]}</div>
          <div className="oc-chip-grid">
            {effects
              .filter((e) => e.category === cat)
              .map((e) => (
                <button key={e.type} className="oc-chip" onClick={() => addEffect(e.type)} title={`${e.label} — hover to preview`}>
                  <div className="oc-chip__preview">
                    <FxPreview demo={e.category} />
                  </div>
                  <span className="oc-chip__label">{e.label}</span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Transitions browser. Clicking applies to the boundary of the selected clip. */
export function TransitionsPanel() {
  const store = useAppStore();
  const transitions = allTransitions();

  /**
   * Click-to-apply: attach to the cut nearest the PLAYHEAD on the selected clip's track, or on
   * the first video track that has a cut at all.
   *
   * The old behaviour was a toast telling the user to drag instead — which is a feature
   * describing itself rather than doing anything. Drag still works and is more precise; this is
   * the one-click path for the common case where the playhead is already at the cut.
   */
  const apply = (type: string) => {
    const state = store.getState();
    const seq = state.sequence();
    const selectedId = state.selectedClipIds[0];
    const track =
      seq.tracks.find((t) => t.clips.some((c) => c.id === selectedId)) ??
      seq.tracks.find((t) => t.kind === 'video' && t.clips.length > 1);
    if (!track) {
      state.notify('Transitions need two clips', 'info', 'Put two clips on one track first.');
      return;
    }
    applyTransitionAtTime(store, track, state.playhead, type);
  };

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div className="oc-section-title">Transitions</div>
      <div className="oc-chip-grid">
        {transitions.map((t) => (
          <button
            key={t.type}
            className="oc-chip"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-opencut-transition', t.type)}
            onClick={() => apply(t.type)}
            title={`${t.label} — click to apply at the playhead, or drag onto a cut`}
          >
            <div className="oc-chip__preview">
              <FxPreview demo={transitionDemo(t.type)} />
            </div>
            <span className="oc-chip__label">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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

/** Text browser: presets that drop a styled text clip on a free track at the playhead. */
export function TextPanel() {
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
                title={`${p.label} — adds a text clip at the playhead`}
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
