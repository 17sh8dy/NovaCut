import {
  allTransitions,
  defaultParams,
  getEffectDef,
  getTextAnimation,
  getTransitionDef,
  packColor,
  removeTransition,
  sample,
  seconds,
  setTransitionDuration,
  setTransitionParam,
  setTransitionType,
  textAnimationsByKind,
  toSeconds,
  unpackColor,
  updateClip,
  upsertKeyframe,
  newKeyframeId,
  TICKS_PER_SECOND,
  type AnimatedValue,
  type Clip,
  type EffectInstance,
  type TextAnimation,
  type TextAnimationKind,
  type TrackId,
  type Transform,
} from '@opencut/core';
import { Diamond, Trash2, Power, ArrowLeftRight } from 'lucide-react';
import { NumberField, Slider, EmptyState, Segmented } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import type { InspectorTab } from '../state/store.js';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'transform', label: 'Transform' },
  { id: 'effects', label: 'Effects' },
  { id: 'audio', label: 'Audio' },
  { id: 'speed', label: 'Speed' },
  { id: 'text', label: 'Text' },
];

/**
 * Everything about the transition sitting on a cut.
 *
 * Type, length and the type's own params, plus a way to remove it. Changing the type re-seeds
 * the params from the new definition's defaults — see `setTransitionType` for why carrying them
 * over would be worse.
 */
function TransitionInspector({ selection }: { selection: { trackId: TrackId; id: string } }) {
  const store = useAppStore();
  const found = useStore((s) => {
    const track = s.sequence().tracks.find((t) => t.id === selection.trackId);
    const transition = track?.transitions.find((t) => t.id === selection.id);
    return track && transition ? { track, transition } : null;
  });

  // The transition can vanish under the panel — an undo, or a clip deleted from beneath it.
  if (!found) {
    return <EmptyState title="Transition gone" hint="It was removed, or the clips it joined were." />;
  }
  const { track, transition } = found;
  const def = getTransitionDef(transition.type);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="oc-inspector__tabs">
        <button className="oc-inspector__tab" data-active>Transition</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div className="oc-field">
          <label>Type</label>
          <select
            className="oc-select"
            value={transition.type}
            onChange={(e) =>
              store.getState().dispatch(setTransitionType(track.id, transition.id, e.target.value))
            }
          >
            {allTransitions().map((t) => (
              <option key={t.type} value={t.type}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="oc-field" style={{ borderBottom: 'none' }}>
          <Slider
            label="Duration"
            value={toSeconds(transition.duration)}
            min={0.1}
            max={4}
            step={0.05}
            unit="s"
            onChange={(v) =>
              store.getState().dispatch(setTransitionDuration(track.id, transition.id, seconds(v)))
            }
          />
        </div>

        {(def?.params ?? []).map((param) => (
          <div className="oc-field" key={param.key} style={{ borderBottom: 'none', paddingTop: 4, paddingBottom: 4 }}>
            <Slider
              label={param.label}
              value={transition.params[param.key] ?? param.default}
              min={param.min}
              max={param.max}
              step={param.step}
              unit={param.unit ?? ''}
              onChange={(v) =>
                store.getState().dispatch(setTransitionParam(track.id, transition.id, param.key, v))
              }
            />
          </div>
        ))}

        <div className="oc-field">
          <button
            className="oc-btn oc-btn--danger"
            onClick={() => {
              store.getState().dispatch(removeTransition(track.id, transition.id));
              store.getState().selectTransition(null);
            }}
          >
            <Trash2 size={14} /> Remove Transition
          </button>
        </div>

        <p className="oc-hint" style={{ padding: '0 var(--space-3)' }}>
          The transition is centred on the cut and borrows time from both clips — it never
          shortens the edit.
        </p>
      </div>
    </div>
  );
}

/** Quick-pick text colors (the full picker is still available alongside these). */
const TEXT_COLORS = [
  '#ffffff', '#000000', '#f5624d', '#ff9f43', '#ffd93d', '#4cd97b',
  '#2dd4bf', '#4d8bf5', '#a763f5', '#ff6bd5', '#9aa4b2', '#1e2530',
];

export function Inspector() {
  const store = useAppStore();
  const tab = useStore((s) => s.inspectorTab);
  const clip = useStore((s) => s.selectedClip());
  const selectedTransition = useStore((s) => s.selectedTransition);

  // A selected transition takes the whole panel. It is not a property OF a clip — it is the
  // join between two — so nesting it under a clip's tabs would put it somewhere it does not
  // belong and make it unreachable whenever neither clip happened to be selected.
  if (selectedTransition) return <TransitionInspector selection={selectedTransition} />;

  if (!clip) {
    return <EmptyState title="No clip selected" hint="Select a clip, or a transition, to edit it" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="oc-inspector__tabs">
        {TABS.filter((t) => (t.id === 'text' ? clip.kind === 'text' : t.id === 'audio' ? !!clip.audio : true)).map((t) => (
          <button
            key={t.id}
            className="oc-inspector__tab"
            data-active={tab === t.id}
            onClick={() => store.getState().setInspectorTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'transform' && <TransformTab clip={clip} />}
        {tab === 'effects' && <EffectsTab clip={clip} />}
        {tab === 'audio' && clip.audio && <AudioTab clip={clip} />}
        {tab === 'speed' && <SpeedTab clip={clip} />}
        {tab === 'text' && clip.text && <TextTab clip={clip} />}
      </div>
    </div>
  );
}

/** Shared hook: update a clip via a coalescing command. */
function useClipUpdater(clip: Clip) {
  const store = useAppStore();
  return (label: string, fn: (c: Clip) => Clip, coalesceKey?: string) => {
    const seq = store.getState().sequence();
    store.getState().dispatch({
      label,
      ...(coalesceKey ? { coalesceKey } : {}),
      apply: (p) => updateClip(p, seq.id, clip.id, fn),
    });
  };
}

/** A labeled animatable numeric row with a keyframe toggle. */
function AnimatedRow({
  clip,
  label,
  field,
  min,
  max,
  step = 0.01,
  unit,
  toValue = (v) => v,
  fromValue = (v) => v,
}: {
  clip: Clip;
  label: string;
  field: keyof Transform;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  toValue?: (v: number) => number;
  fromValue?: (v: number) => number;
}) {
  const playhead = useStore((s) => s.playhead);
  const update = useClipUpdater(clip);
  const av = clip.transform[field] as AnimatedValue;
  const local = playhead - clip.start;
  const current = toValue(sample(av, local));

  const setValue = (v: number) => {
    const raw = fromValue(v);
    update(
      `Set ${label}`,
      (c) => {
        const t = { ...c.transform };
        const cur = t[field] as AnimatedValue;
        // If animated, write a keyframe at the playhead; else set the static value.
        if (cur.keyframes.length > 0) {
          t[field] = upsertKeyframe(cur, {
            id: newKeyframeId(),
            time: Math.max(0, local),
            value: raw,
            interpolation: 'linear',
          }) as never;
        } else {
          t[field] = { ...cur, static: raw } as never;
        }
        return { ...c, transform: t };
      },
      `transform:${field}:${clip.id}`,
    );
  };

  const addKeyframe = () => {
    update(`Keyframe ${label}`, (c) => {
      const t = { ...c.transform };
      const cur = t[field] as AnimatedValue;
      t[field] = upsertKeyframe(cur, {
        id: newKeyframeId(),
        time: Math.max(0, local),
        value: fromValue(current),
        interpolation: 'linear',
      }) as never;
      return { ...c, transform: t };
    });
  };

  return (
    <div className="oc-field">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="oc-field__label">{label}</span>
        <button
          className="oc-tt"
          data-on={av.keyframes.length > 0}
          onClick={addKeyframe}
          title="Add keyframe at playhead"
        >
          <Diamond size={13} />
        </button>
      </div>
      {/*
        min/max/step are declared in MODEL units while `current` is already in DISPLAY units
        (Scale and Opacity multiply by 100 to read as a percentage). Handing the Slider that
        mixture put the thumb at `value / (max - min)` of a range it does not belong to: Opacity
        at 100% resolved to 10000% of a 0-1 track, so the fill was permanently wider than the
        bar and the thumb sat far outside the panel. The control looked full at every value and
        its endpoint was unreachable.

        Converting the bounds through the same `toValue` the display uses puts all four numbers
        in one unit system. `setValue` already expects display units and converts back with
        `fromValue`, so behaviour is unchanged — only the geometry is now truthful. The step is
        converted as a DELTA rather than a point, which is what keeps it correct for the rows
        whose transform has an offset rather than a pure scale.
      */}
      <Slider
        value={current}
        min={toValue(min)}
        max={toValue(max)}
        step={toValue(min + step) - toValue(min)}
        unit={unit}
        onChange={setValue}
      />
    </div>
  );
}

function TransformTab({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip);
  return (
    <>
      <AnimatedRow clip={clip} label="Position X" field="x" min={-2000} max={2000} step={1} unit="px" />
      <AnimatedRow clip={clip} label="Position Y" field="y" min={-2000} max={2000} step={1} unit="px" />
      <AnimatedRow clip={clip} label="Scale" field="scaleX" min={0} max={4} step={0.01} toValue={(v) => v * 100} fromValue={(v) => v / 100} unit="%" />
      <AnimatedRow clip={clip} label="Rotation" field="rotation" min={-180} max={180} step={1} unit="°" />
      <AnimatedRow clip={clip} label="Opacity" field="opacity" min={0} max={1} step={0.01} toValue={(v) => v * 100} fromValue={(v) => v / 100} unit="%" />
      <div className="oc-field">
        <span className="oc-field__label">Blend Mode</span>
        <select
          value={clip.blendMode}
          onChange={(e) => update('Set Blend Mode', (c) => ({ ...c, blendMode: e.target.value as Clip['blendMode'] }))}
          style={{ height: 30, background: 'var(--surface-3)', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '0 8px' }}
        >
          {['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'difference'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function EffectsTab({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip);

  if (clip.effects.length === 0) {
    return <EmptyState title="No effects" hint="Add effects from the Effects panel" />;
  }

  const setParam = (fx: EffectInstance, key: string, value: number) => {
    update(
      'Adjust Effect',
      (c) => ({
        ...c,
        effects: c.effects.map((e) =>
          e.id === fx.id ? { ...e, params: { ...e.params, [key]: { ...e.params[key]!, static: value } } } : e,
        ),
      }),
      `fx:${fx.id}:${key}`,
    );
  };
  const removeEffect = (id: string) =>
    update('Remove Effect', (c) => ({ ...c, effects: c.effects.filter((e) => e.id !== id) }));
  const toggleEffect = (id: string) =>
    update('Toggle Effect', (c) => ({ ...c, effects: c.effects.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) }));

  return (
    <>
      {clip.effects.map((fx) => {
        const def = getEffectDef(fx.type);
        // An effect whose registry entry is gone — an unloaded plugin, or a built-in that was
        // retired (`speed-ramp` was, once it turned out to be a no-op) — used to render as
        // NOTHING here while staying in the document. Invisible-but-present is the worst of
        // both: the user cannot see it and cannot remove it. Say what it is and offer the bin.
        if (!def) {
          return (
            <div key={fx.id} style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
              <div className="oc-section-title" style={{ textTransform: 'none' }}>
                <span style={{ color: 'var(--text-disabled)' }}>Unknown effect “{fx.type}”</span>
                <button className="oc-tt" onClick={() => removeEffect(fx.id)} title="Remove">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        }
        return (
          <div key={fx.id} style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
            <div className="oc-section-title" style={{ textTransform: 'none' }}>
              <span style={{ color: fx.enabled ? 'var(--text-secondary)' : 'var(--text-disabled)' }}>{def.label}</span>
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="oc-tt" data-on={fx.enabled} onClick={() => toggleEffect(fx.id)} title="Enable/disable">
                  <Power size={13} />
                </button>
                <button className="oc-tt" onClick={() => removeEffect(fx.id)} title="Remove">
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            {fx.enabled &&
              def.params.map((param) =>
                // Colour params ride the numeric path packed into one float (see `packColor` in
                // core); this is the only place in the video UI that unpacks them.
                param.kind === 'color' ? (
                  <div className="oc-field" key={param.key} style={{ borderBottom: 'none', paddingTop: 4, paddingBottom: 4 }}>
                    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{param.label}</label>
                    <input
                      type="color"
                      value={unpackColor(fx.params[param.key]?.static ?? param.default)}
                      onChange={(e) => setParam(fx, param.key, packColor(e.target.value))}
                      style={{ width: 34, height: 22, padding: 0, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', cursor: 'pointer' }}
                    />
                  </div>
                ) : (
                <div className="oc-field" key={param.key} style={{ borderBottom: 'none', paddingTop: 4, paddingBottom: 4 }}>
                  <Slider
                    label={param.label}
                    value={fx.params[param.key]?.static ?? param.default}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    unit={param.unit ?? ''}
                    onChange={(v) => setParam(fx, param.key, v)}
                  />
                </div>
                ),
              )}
          </div>
        );
      })}
    </>
  );
}

function AudioTab({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip);
  const a = clip.audio!;
  const setAudio = (label: string, patch: Partial<typeof a>, key?: string) =>
    update(label, (c) => ({ ...c, audio: { ...c.audio!, ...patch } }), key);

  return (
    <>
      <div className="oc-field">
        <Slider
          label="Volume"
          value={a.volume.static * 100}
          min={0}
          max={200}
          step={1}
          unit="%"
          onChange={(v) => setAudio('Set Volume', { volume: { ...a.volume, static: v / 100 } }, `vol:${clip.id}`)}
        />
      </div>
      <div className="oc-field">
        <div className="oc-field__row">
          <div>
            <span className="oc-field__label">Fade In (s)</span>
            <NumberField value={a.fadeIn / TICKS_PER_SECOND} step={0.1} min={0} onChange={(v) => setAudio('Fade In', { fadeIn: Math.round(v * TICKS_PER_SECOND) })} />
          </div>
          <div>
            <span className="oc-field__label">Fade Out (s)</span>
            <NumberField value={a.fadeOut / TICKS_PER_SECOND} step={0.1} min={0} onChange={(v) => setAudio('Fade Out', { fadeOut: Math.round(v * TICKS_PER_SECOND) })} />
          </div>
        </div>
      </div>
      <div className="oc-field">
        <Slider label="Pitch (semitones)" value={a.pitch} min={-12} max={12} step={1} onChange={(v) => setAudio('Set Pitch', { pitch: v }, `pitch:${clip.id}`)} />
      </div>
      <ToggleField label="Mute" value={a.muted} onChange={(v) => setAudio('Mute', { muted: v })} />
      <ToggleField label="Normalize" value={a.normalize} onChange={(v) => setAudio('Normalize', { normalize: v })} />
    </>
  );
}

function SpeedTab({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip);
  const s = clip.speed;
  const RATES = [0.1, 0.25, 0.5, 1, 2, 4, 8];
  return (
    <>
      <div className="oc-field">
        <span className="oc-field__label">Speed</span>
        <Segmented
          options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
          value={String(s.rate)}
          onChange={(v) => update('Set Speed', (c) => ({ ...c, speed: { ...c.speed, rate: parseFloat(v) } }))}
        />
      </div>
      <div className="oc-field">
        <Slider label="Fine Speed" value={s.rate} min={0.1} max={8} step={0.05} unit="×" onChange={(v) => update('Set Speed', (c) => ({ ...c, speed: { ...c.speed, rate: v } }), `speed:${clip.id}`)} />
      </div>
      <ToggleField label="Reverse" value={s.reverse} icon={<ArrowLeftRight size={13} />} onChange={(v) => update('Reverse', (c) => ({ ...c, speed: { ...c.speed, reverse: v } }))} />
      <ToggleField label="Preserve Pitch" value={s.preservePitch} onChange={(v) => update('Preserve Pitch', (c) => ({ ...c, speed: { ...c.speed, preservePitch: v } }))} />
    </>
  );
}

function TextTab({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip);
  const t = clip.text!;
  const setText = (label: string, patch: Partial<typeof t>, key?: string) =>
    update(label, (c) => ({ ...c, text: { ...c.text!, ...patch }, name: patch.content ?? c.name }), key);

  return (
    <>
      <div className="oc-field">
        <span className="oc-field__label">Content</span>
        <textarea
          value={t.content}
          onChange={(e) => setText('Edit Text', { content: e.target.value }, `text:${clip.id}`)}
          rows={2}
          style={{ resize: 'vertical', background: 'var(--surface-3)', border: '1px solid transparent', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: 8, font: 'inherit', outline: 'none' }}
        />
      </div>
      <div className="oc-field">
        <Slider label="Font Size" value={t.fontSize} min={8} max={400} step={1} unit="px" onChange={(v) => setText('Font Size', { fontSize: v }, `fs:${clip.id}`)} />
      </div>
      <div className="oc-field">
        <span className="oc-field__label">Weight</span>
        <Segmented
          options={[
            { value: '400', label: 'Regular' },
            { value: '600', label: 'Semibold' },
            { value: '800', label: 'Bold' },
          ]}
          value={String(t.fontWeight >= 800 ? 800 : t.fontWeight >= 600 ? 600 : 400)}
          onChange={(v) => setText('Weight', { fontWeight: parseInt(v) })}
        />
      </div>
      <div className="oc-field">
        <span className="oc-field__label">Alignment</span>
        <Segmented
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'right', label: 'Right' },
          ]}
          value={t.align === 'justify' ? 'left' : t.align}
          onChange={(v) => setText('Align', { align: v as typeof t.align })}
        />
      </div>
      <div className="oc-field">
        <div className="oc-field__row">
          <div>
            <span className="oc-field__label">Color</span>
            <input type="color" value={t.color} onChange={(e) => setText('Text Color', { color: e.target.value })} style={{ width: '100%', height: 28, border: 'none', borderRadius: 'var(--radius-sm)', background: 'var(--surface-3)', cursor: 'pointer' }} />
          </div>
          <div>
            <span className="oc-field__label">Letter Spacing</span>
            <NumberField value={t.letterSpacing} step={0.5} onChange={(v) => setText('Letter Spacing', { letterSpacing: v })} />
          </div>
        </div>
        <div className="oc-swatches">
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              className="oc-swatch"
              style={{ background: c }}
              data-active={t.color.toLowerCase() === c.toLowerCase()}
              title={c}
              onClick={() => setText('Text Color', { color: c })}
            />
          ))}
        </div>
      </div>
      <ToggleField label="Italic" value={t.italic} onChange={(v) => setText('Italic', { italic: v })} />
      <ToggleField label="Underline" value={t.underline} onChange={(v) => setText('Underline', { underline: v })} />

      {/*
        Animation slots. The browser is where a user goes to CHOOSE one (it has previews); this
        is where they tune the one they chose — duration and the animation's own params — and
        where they turn it off. Both surfaces write the same three fields.
      */}
      <div className="oc-section-title" style={{ paddingLeft: 0 }}>Animation</div>
      <AnimationSlot clip={clip} slot="animateIn" kind="in" label="In" />
      <AnimationSlot clip={clip} slot="animateOut" kind="out" label="Out" />
      <AnimationSlot clip={clip} slot="animateLoop" kind="loop" label="Loop" />

      {/*
        The decoration fields. These existed on TextStyle from the start but had no controls, so
        the only way to get a stroke was to not have one — which is why the old presets were six
        sizes of the same white text. Each is opt-in: toggling one on seeds a value that reads
        clearly at the default 96px, because a stroke of 0 or a fully transparent glow looks
        identical to the feature being broken.
      */}
      <div className="oc-section-title" style={{ paddingLeft: 0 }}>Style</div>

      <ToggleField
        label="Outline"
        value={!!t.stroke}
        onChange={(v) => setText('Outline', { stroke: v ? { color: '#000000', width: 8 } : undefined })}
      />
      {t.stroke && (
        <div className="oc-field">
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">Colour</span>
              <ColorInput value={t.stroke.color} onChange={(c) => setText('Outline Colour', { stroke: { ...t.stroke!, color: c } })} />
            </div>
            <div>
              <span className="oc-field__label">Width</span>
              <NumberField value={t.stroke.width} step={1} onChange={(v) => setText('Outline Width', { stroke: { ...t.stroke!, width: Math.max(0, v) } })} />
            </div>
          </div>
        </div>
      )}

      <ToggleField
        label="Shadow"
        value={!!t.shadow}
        onChange={(v) => setText('Shadow', { shadow: v ? { color: '#000000aa', blur: 12, x: 0, y: 4 } : undefined })}
      />
      {t.shadow && (
        <div className="oc-field">
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">Colour</span>
              <ColorInput value={t.shadow.color} onChange={(c) => setText('Shadow Colour', { shadow: { ...t.shadow!, color: c } })} />
            </div>
            <div>
              <span className="oc-field__label">Blur</span>
              <NumberField value={t.shadow.blur} step={1} onChange={(v) => setText('Shadow Blur', { shadow: { ...t.shadow!, blur: Math.max(0, v) } })} />
            </div>
          </div>
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">Offset X</span>
              <NumberField value={t.shadow.x} step={1} onChange={(v) => setText('Shadow X', { shadow: { ...t.shadow!, x: v } })} />
            </div>
            <div>
              <span className="oc-field__label">Offset Y</span>
              <NumberField value={t.shadow.y} step={1} onChange={(v) => setText('Shadow Y', { shadow: { ...t.shadow!, y: v } })} />
            </div>
          </div>
        </div>
      )}

      <ToggleField
        label="Glow"
        value={!!t.glow}
        onChange={(v) => setText('Glow', { glow: v ? { color: '#31d7ff', radius: 24, intensity: 1 } : undefined })}
      />
      {t.glow && (
        <div className="oc-field">
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">Colour</span>
              <ColorInput value={t.glow.color} onChange={(c) => setText('Glow Colour', { glow: { ...t.glow!, color: c } })} />
            </div>
            <div>
              <span className="oc-field__label">Radius</span>
              <NumberField value={t.glow.radius} step={2} onChange={(v) => setText('Glow Radius', { glow: { ...t.glow!, radius: Math.max(0, v) } })} />
            </div>
          </div>
          <Slider label="Intensity" value={t.glow.intensity} min={0} max={1} step={0.05} onChange={(v) => setText('Glow Intensity', { glow: { ...t.glow!, intensity: v } }, `glow:${clip.id}`)} />
        </div>
      )}

      <ToggleField
        label="Gradient Fill"
        value={!!t.gradient}
        onChange={(v) => setText('Gradient', { gradient: v ? { from: '#ff9a3d', to: '#ff2e63', angle: 120 } : undefined })}
      />
      {t.gradient && (
        <div className="oc-field">
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">From</span>
              <ColorInput value={t.gradient.from} onChange={(c) => setText('Gradient From', { gradient: { ...t.gradient!, from: c } })} />
            </div>
            <div>
              <span className="oc-field__label">To</span>
              <ColorInput value={t.gradient.to} onChange={(c) => setText('Gradient To', { gradient: { ...t.gradient!, to: c } })} />
            </div>
          </div>
          <Slider label="Angle" value={t.gradient.angle} min={0} max={360} step={1} unit="°" onChange={(v) => setText('Gradient Angle', { gradient: { ...t.gradient!, angle: v } }, `grad:${clip.id}`)} />
        </div>
      )}

      <ToggleField
        label="Background"
        value={!!t.background}
        onChange={(v) => setText('Background', { background: v ? { color: '#0f1115e0', padding: 24, radius: 10 } : undefined })}
      />
      {t.background && (
        <div className="oc-field">
          <div className="oc-field__row">
            <div>
              <span className="oc-field__label">Colour</span>
              <ColorInput value={t.background.color} onChange={(c) => setText('Background Colour', { background: { ...t.background!, color: c } })} />
            </div>
            <div>
              <span className="oc-field__label">Padding</span>
              <NumberField value={t.background.padding} step={2} onChange={(v) => setText('Background Padding', { background: { ...t.background!, padding: Math.max(0, v) } })} />
            </div>
          </div>
          <Slider label="Corner Radius" value={Math.min(200, t.background.radius)} min={0} max={200} step={1} unit="px" onChange={(v) => setText('Background Radius', { background: { ...t.background!, radius: v } }, `bgr:${clip.id}`)} />
        </div>
      )}
    </>
  );
}

/**
 * One animation slot: pick an animation, set how long it runs, tune its params, or clear it.
 *
 * The duration control is in seconds and is the same field for all three slots, but it means
 * something different in each — how long the entrance takes, how long the exit takes, how long
 * one loop cycle lasts — so the label changes rather than the control. Calling it "Duration"
 * everywhere would leave a user setting a 4-second Loop expecting the pulse to stop after four
 * seconds.
 */
function AnimationSlot({
  clip,
  slot,
  kind,
  label,
}: {
  clip: Clip;
  slot: 'animateIn' | 'animateOut' | 'animateLoop';
  kind: TextAnimationKind;
  label: string;
}) {
  const update = useClipUpdater(clip);
  const current = clip.text?.[slot];
  const def = current ? getTextAnimation(current.type) : undefined;
  const options = textAnimationsByKind(kind);

  const setSlot = (value: TextAnimation | undefined, cmdLabel: string, coalesceKey?: string) =>
    update(cmdLabel, (c) => ({ ...c, text: { ...c.text!, [slot]: value } }), coalesceKey);

  const choose = (type: string) => {
    if (!type) return setSlot(undefined, `Remove ${label} Animation`);
    const chosen = getTextAnimation(type);
    if (!chosen) return;
    setSlot(
      { type, params: defaultParams(chosen.params), duration: chosen.duration },
      `Set ${label} Animation`,
    );
  };

  return (
    <div className="oc-field">
      <span className="oc-field__label">{label}</span>
      <select value={current?.type ?? ''} onChange={(e) => choose(e.target.value)} className="oc-select">
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.type} value={o.type}>
            {o.label}
          </option>
        ))}
      </select>

      {current && def && (
        <div className="oc-animslot__body">
          <Slider
            label={kind === 'loop' ? 'Cycle' : 'Duration'}
            value={current.duration}
            min={0.05}
            max={kind === 'loop' ? 10 : 5}
            step={0.05}
            unit="s"
            onChange={(v) => setSlot({ ...current, duration: v }, `${label} Duration`, `anim:${slot}:${clip.id}`)}
          />
          {def.params.map((param) => (
            <Slider
              key={param.key}
              label={param.label}
              value={current.params[param.key] ?? param.default}
              min={param.min}
              max={param.max}
              step={param.step}
              unit={param.unit}
              onChange={(v) =>
                setSlot(
                  { ...current, params: { ...current.params, [param.key]: v } },
                  `${label} ${param.label}`,
                  `anim:${slot}:${param.key}:${clip.id}`,
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A colour input that does not destroy alpha.
 *
 * `input[type=color]` only speaks `#rrggbb`. Several text defaults are `#rrggbbaa` — a shadow at
 * 67% and a background scrim at 88% — and binding them straight to the input would silently
 * promote every one of them to fully opaque the first time the user opened the picker. So the
 * input sees the opaque half and the alpha suffix is carried across unchanged.
 */
function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rgb = value.slice(0, 7);
  const alpha = value.length > 7 ? value.slice(7) : '';
  return (
    <input
      type="color"
      value={rgb}
      onChange={(e) => onChange(e.target.value + alpha)}
      style={{ width: '100%', height: 28, border: 'none', borderRadius: 'var(--radius-sm)', background: 'var(--surface-3)', cursor: 'pointer' }}
    />
  );
}

function ToggleField({ label, value, onChange, icon }: { label: string; value: boolean; onChange: (v: boolean) => void; icon?: React.ReactNode }) {
  return (
    <div className="oc-field" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <span className="oc-field__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}
        {label}
      </span>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 38,
          height: 22,
          borderRadius: 'var(--radius-full)',
          border: 'none',
          cursor: 'pointer',
          background: value ? 'var(--accent)' : 'var(--surface-4)',
          position: 'relative',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: value ? 19 : 3,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left var(--dur-fast) var(--ease-out)',
          }}
        />
      </button>
    </div>
  );
}
