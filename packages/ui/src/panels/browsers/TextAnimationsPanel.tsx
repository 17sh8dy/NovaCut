/**
 * The Text Animations browser: In / Out / Loop.
 *
 * Three tabs of twenty-five rather than one list of seventy-five, because "how does it arrive",
 * "how does it leave" and "what does it do while it's there" are three different decisions a
 * user makes at three different moments — and a title routinely gets one of each.
 */

import { useMemo, useState } from 'react';
import { Type } from 'lucide-react';
import {
  defaultParams,
  getTextAnimation,
  textAnimationsByKind,
  updateClip,
  type Clip,
  type TextAnimation,
  type TextAnimationDefinition,
  type TextAnimationKind,
} from '@opencut/core';
import { EmptyState } from '../../components/primitives/index.js';
import { useAppStore, useStore } from '../../state/context.js';
import {
  bucket,
  CategoryTabs,
  ChipSection,
  ItemChip,
  matches,
  NoResults,
  SearchBox,
  usePreviewClock,
  useShelfMemory,
} from './shared.js';

const TABS: { value: TextAnimationKind; label: string }[] = [
  { value: 'in', label: 'In' },
  { value: 'out', label: 'Out' },
  { value: 'loop', label: 'Loop' },
];

/** Which `TextStyle` slot each tab writes to. */
const SLOT: Record<TextAnimationKind, 'animateIn' | 'animateOut' | 'animateLoop'> = {
  in: 'animateIn',
  out: 'animateOut',
  loop: 'animateLoop',
};

const PREVIEW_WORD = 'Title';

/**
 * A chip that previews itself by running the animation's own `apply()` on every frame.
 *
 * The output is numbers — offsets in text-widths, scales, a rotation, an opacity, a reveal —
 * which map cleanly onto CSS because they are the same quantities a transform expresses. The
 * one deliberate approximation is `passes`: a blur becomes a CSS blur and everything else
 * (glitch, chromatic aberration, the reveal mask) is dropped, since reproducing a GPU shader in
 * a 90-pixel chip would cost more than it communicates. Those animations still preview their
 * motion honestly; they simply understate their texture.
 */
function AnimationPreview({ def, playing }: { def: TextAnimationDefinition; playing: boolean }) {
  // Entrances rest arrived (1); exits rest not-yet-gone (0); loops rest at the top of a cycle.
  const progress = usePreviewClock(playing, def.duration, def.kind === 'loop', def.kind === 'in' ? 1 : 0);
  const out = useMemo(
    () => def.apply({ content: PREVIEW_WORD, progress, params: defaultParams(def.params) }),
    [def, progress],
  );

  const shown =
    out.reveal === undefined
      ? PREVIEW_WORD
      : PREVIEW_WORD.slice(0, Math.ceil(out.reveal * PREVIEW_WORD.length));

  const blur = out.passes?.find((p) => p.type === 'blur')?.params.radius ?? 0;

  return (
    <div className="oc-animprev" aria-hidden>
      <span
        className="oc-animprev__text"
        style={{
          // dx/dy are fractions of the text's own size, which is exactly what a percentage
          // translate means in CSS — so the preview's geometry matches the compositor's by
          // construction rather than by a fudge factor.
          transform: `translate(${(out.dx ?? 0) * 100}%, ${(out.dy ?? 0) * 100}%) scale(${out.scaleX ?? 1}, ${out.scaleY ?? 1}) rotate(${out.rotate ?? 0}deg)`,
          opacity: out.opacity ?? 1,
          // Scaled down hard: the chip is a fraction of the frame, so a 28px blur would erase it.
          filter: blur > 0.25 ? `blur(${Math.min(6, blur * 0.12)}px)` : undefined,
        }}
      >
        {shown || ' '}
      </span>
    </div>
  );
}

export function TextAnimationsPanel() {
  const store = useAppStore();
  const [kind, setKind] = useState<TextAnimationKind>('in');
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const { favorites, recents, toggleFavorite, markUsed } = useShelfMemory('text-anim');

  const selectedId = useStore((s) => s.selectedClipIds[0]);
  const seq = useStore((s) => s.sequence());
  const selected: Clip | undefined = useMemo(
    () => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedId),
    [seq, selectedId],
  );
  const applied = selected?.text?.[SLOT[kind]]?.type;

  const items = useMemo(
    () => textAnimationsByKind(kind).filter((d) => matches(query, d.label, d.type)),
    [kind, query],
  );
  const { favorite, recent, rest } = bucket(items, (d) => d.type, favorites, recents);

  /**
   * Apply, or clear when the same animation is clicked again.
   *
   * Click-to-toggle is the "reset to None" affordance: the chip that is currently applied shows
   * as active, and clicking it removes the animation. There is a None button too, but making
   * the applied chip undo itself means the user never has to hunt for the off switch.
   */
  const apply = (type: string) => {
    const state = store.getState();
    if (!selected || selected.kind !== 'text') {
      return state.notify('Select a text clip first', 'info', 'Animations apply to text clips.');
    }
    const def = getTextAnimation(type);
    if (!def) return;
    const slot = SLOT[kind];
    const clear = applied === type;
    const value: TextAnimation | undefined = clear
      ? undefined
      : { type, params: defaultParams(def.params), duration: def.duration };

    const sequence = state.sequence();
    state.dispatch({
      label: clear ? 'Remove Text Animation' : `Add ${def.label}`,
      apply: (proj) =>
        updateClip(proj, sequence.id, selected.id, (c) => ({
          ...c,
          text: { ...c.text!, [slot]: value },
        })),
    });
    if (!clear) markUsed(type);
    state.setInspectorTab('text');
  };

  const clearSlot = () => {
    const state = store.getState();
    if (!selected || selected.kind !== 'text') return;
    const sequence = state.sequence();
    state.dispatch({
      label: 'Remove Text Animation',
      apply: (proj) =>
        updateClip(proj, sequence.id, selected.id, (c) => ({
          ...c,
          text: { ...c.text!, [SLOT[kind]]: undefined },
        })),
    });
  };

  const chip = (def: TextAnimationDefinition) => (
    <ItemChip
      key={def.type}
      label={def.label}
      title={`${def.label} — click to apply${applied === def.type ? ' (click again to remove)' : ''}`}
      favorite={favorites.includes(def.type)}
      applied={applied === def.type}
      onToggleFavorite={() => toggleFavorite(def.type)}
      onClick={() => apply(def.type)}
      onPointerEnter={() => setHovered(def.type)}
      onPointerLeave={() => setHovered((h) => (h === def.type ? null : h))}
    >
      <AnimationPreview def={def} playing={hovered === def.type} />
    </ItemChip>
  );

  return (
    <div className="oc-browser">
      <CategoryTabs tabs={TABS} value={kind} onChange={setKind} />
      <SearchBox value={query} onChange={setQuery} placeholder="Search animations" />

      <div className="oc-browser__scroll">
        <button className="oc-browser__none-btn" data-active={!applied} onClick={clearSlot}>
          None
          {applied && <span className="oc-browser__none-sub">clears “{getTextAnimation(applied)?.label ?? applied}”</span>}
        </button>

        {items.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <>
            <ChipSection title="Favourites" count={favorite.length}>{favorite.map(chip)}</ChipSection>
            <ChipSection title="Recent" count={recent.length}>{recent.map(chip)}</ChipSection>
            <ChipSection title={favorite.length || recent.length ? 'All' : TABS.find((t) => t.value === kind)!.label}
              count={rest.length}>
              {rest.map(chip)}
            </ChipSection>
          </>
        )}
      </div>

      {!selected || selected.kind !== 'text' ? (
        <div className="oc-browser__hint">
          <EmptyState icon={<Type size={20} />} title="Select a text clip" hint="Animations apply to the selected title." />
        </div>
      ) : null}
    </div>
  );
}
