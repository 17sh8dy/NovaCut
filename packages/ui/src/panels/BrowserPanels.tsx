import { Sparkles, Type as TypeIcon } from 'lucide-react';
import {
  addClip,
  allEffects,
  allTransitions,
  createTextClip,
  instantiateEffect,
  updateClip,
  type EffectCategory,
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

const TEXT_PRESETS = [
  { name: 'Title', size: 120, weight: 800 },
  { name: 'Subtitle', size: 64, weight: 600 },
  { name: 'Caption', size: 44, weight: 500 },
  { name: 'Lower Third', size: 52, weight: 700 },
  { name: 'Callout', size: 72, weight: 800 },
  { name: 'Minimal', size: 56, weight: 400 },
];

/** Text browser: presets that drop a new text clip at the playhead. */
export function TextPanel() {
  const store = useAppStore();

  const addText = (preset: (typeof TEXT_PRESETS)[number]) => {
    const seq = store.getState().sequence();
    const clip = createTextClip(seq.playhead, preset.name);
    if (clip.text) {
      clip.text.fontSize = preset.size;
      clip.text.fontWeight = preset.weight;
    }
    const videoTrack = seq.tracks.find((t) => t.kind === 'video');
    if (!videoTrack) return;
    store.getState().dispatch(addClip(videoTrack.id, clip));
    store.getState().selectClip(clip.id);
    store.getState().setInspectorTab('text');
  };

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div className="oc-section-title">Text Presets</div>
      <div style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="oc-list-item"
            style={{ background: 'var(--surface-2)', justifyContent: 'space-between' }}
            onClick={() => addText(p)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TypeIcon size={16} />
              <span style={{ fontWeight: p.weight > 600 ? 700 : 500 }}>{p.name}</span>
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{p.size}px</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PlaceholderPanel({ title, hint }: { title: string; hint: string }) {
  return <EmptyState icon={<Sparkles size={36} />} title={title} hint={hint} />;
}
