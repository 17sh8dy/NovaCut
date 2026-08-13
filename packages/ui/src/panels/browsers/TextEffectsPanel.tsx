/**
 * The Text Effects browser.
 *
 * Each entry is a recipe over real effects (see `textEffects.ts`), so clicking one appends
 * ordinary `EffectInstance`s to the clip. The user can then open the Effects tab and tune or
 * delete any part of it — a preset here is a starting point, not a black box.
 */

import { useMemo, useState } from 'react';
import { Type } from 'lucide-react';
import {
  instantiateTextEffect,
  TEXT_EFFECT_GROUPS,
  TEXT_EFFECTS,
  updateClip,
  type TextEffectDefinition,
  type TextEffectGroup,
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
  useShelfMemory,
} from './shared.js';

type Tab = TextEffectGroup | 'all';

/**
 * Short tab labels for long group names.
 *
 * The groups are named for reading in a heading ("Outline & Shadow"); a tab strip in a 250px
 * panel is not that place. The strip scrolls, but a user should not have to scroll to discover
 * that a category exists.
 */
const TAB_LABEL: Record<TextEffectGroup, string> = {
  'Glow & Light': 'Glow',
  'Outline & Shadow': 'Shadow',
  Color: 'Color',
  Texture: 'Texture',
  Broken: 'Broken',
};

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  ...TEXT_EFFECT_GROUPS.map((g) => ({ value: g as Tab, label: TAB_LABEL[g] })),
];

/**
 * The preview renders the word "Text" with a CSS impression of the recipe.
 *
 * Mapping each recipe step to the nearest CSS text treatment — outline to `-webkit-text-stroke`,
 * drop-shadow and glow to `text-shadow`, gradients to a clipped background — keeps the chip
 * honest about the *character* of the effect (is it glowing, outlined, broken?) without
 * pretending to be a GPU render. The same approach the text-preset swatches already take, for
 * the same reason.
 */
function TextEffectPreview({ def }: { def: TextEffectDefinition }) {
  const style = useMemo(() => {
    const shadows: string[] = [];
    let stroke: string | undefined;
    let gradient: { from: string; to: string; angle: number } | undefined;
    let color: string | undefined;
    let filter: string | undefined;

    const hex = (v: number | undefined, fallback: string) =>
      v === undefined ? fallback : `#${Math.max(0, Math.round(v)).toString(16).padStart(6, '0')}`;

    for (const step of def.steps) {
      const p = step.params;
      switch (step.type) {
        case 'outline':
          stroke = `${Math.max(0.5, (p.width ?? 8) * 0.14)}px ${hex(p.color, '#ffffff')}`;
          break;
        case 'drop-shadow': {
          const a = ((p.angle ?? 315) * Math.PI) / 180;
          const d = (p.distance ?? 20) * 0.13;
          shadows.push(`${(Math.cos(a) * d).toFixed(1)}px ${(-Math.sin(a) * d).toFixed(1)}px ${((p.softness ?? 10) * 0.2).toFixed(1)}px ${hex(p.color, '#000000')}`);
          break;
        }
        case 'glow':
        case 'bloom':
          shadows.push(`0 0 ${Math.round((p.radius ?? 20) * 0.35)}px currentColor`);
          break;
        case 'gradient-overlay':
          gradient = { from: hex(p.color, '#6d5efc'), to: hex(p.color2, '#31d7ff'), angle: p.angle ?? 90 };
          break;
        case 'color-overlay':
        case 'duotone':
          color = hex(p.color, '#6d5efc');
          break;
        case 'blur':
        case 'dreamy':
          filter = `blur(${Math.min(3, (p.radius ?? 6) * 0.12).toFixed(2)}px)`;
          break;
        case 'chromatic-aberration':
        case 'rgb-split':
          shadows.push(`-2px 0 0 #ff0040`, `2px 0 0 #00e5ff`);
          break;
        case 'film-grain':
        case 'halftone':
        case 'pixelate':
        case 'posterize':
          filter = 'contrast(1.6)';
          break;
        case 'glitch-fx':
        case 'vhs':
          shadows.push(`-3px 1px 0 #ff0040`, `3px -1px 0 #00e5ff`);
          break;
      }
    }

    return {
      textShadow: shadows.length ? shadows.join(', ') : undefined,
      WebkitTextStroke: stroke,
      filter,
      ...(gradient
        ? {
            backgroundImage: `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`,
            WebkitBackgroundClip: 'text' as const,
            backgroundClip: 'text' as const,
            color: 'transparent',
          }
        : { color: color ?? '#ffffff' }),
    };
  }, [def]);

  return (
    <div className="oc-animprev oc-animprev--stage" aria-hidden>
      <span className="oc-animprev__text" style={style}>
        Text
      </span>
    </div>
  );
}

export function TextEffectsPanel() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const { favorites, recents, toggleFavorite, markUsed } = useShelfMemory('text-fx');

  const selectedId = useStore((s) => s.selectedClipIds[0]);
  const seq = useStore((s) => s.sequence());
  const selected = useMemo(
    () => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedId),
    [seq, selectedId],
  );

  const items = useMemo(
    () =>
      TEXT_EFFECTS.filter((d) => tab === 'all' || d.group === tab).filter((d) =>
        matches(query, d.label, d.group, d.hint),
      ),
    [tab, query],
  );
  const { favorite, recent, rest } = bucket(items, (d) => d.id, favorites, recents);

  const apply = (id: string) => {
    const state = store.getState();
    if (!selected) return state.notify('Select a clip first', 'info');
    const instances = instantiateTextEffect(id);
    if (instances.length === 0) return;
    const sequence = state.sequence();
    const def = TEXT_EFFECTS.find((t) => t.id === id);
    state.dispatch({
      // One command for the whole recipe, so a three-effect preset is one undo rather than
      // three — the user thinks of it as a single action and Ctrl+Z should agree.
      label: `Add ${def?.label ?? 'Text Effect'}`,
      apply: (p) =>
        updateClip(p, sequence.id, selected.id, (c) => ({ ...c, effects: [...c.effects, ...instances] })),
    });
    markUsed(id);
    state.setInspectorTab('effects');
    state.notify('Text effect applied', 'success');
  };

  const chip = (def: TextEffectDefinition) => (
    <ItemChip
      key={def.id}
      label={def.label}
      title={`${def.label} — ${def.hint}`}
      favorite={favorites.includes(def.id)}
      onToggleFavorite={() => toggleFavorite(def.id)}
      onClick={() => apply(def.id)}
    >
      <TextEffectPreview def={def} />
    </ItemChip>
  );

  return (
    <div className="oc-browser">
      <CategoryTabs tabs={TABS} value={tab} onChange={setTab} />
      <SearchBox value={query} onChange={setQuery} placeholder="Search text effects" />

      <div className="oc-browser__scroll">
        {items.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <>
            <ChipSection title="Favourites" count={favorite.length}>{favorite.map(chip)}</ChipSection>
            <ChipSection title="Recent" count={recent.length}>{recent.map(chip)}</ChipSection>
            <ChipSection
              title={favorite.length || recent.length || tab === 'all' ? 'All' : tab}
              count={rest.length}
            >
              {rest.map(chip)}
            </ChipSection>
          </>
        )}
      </div>

      {!selected && (
        <div className="oc-browser__hint">
          <EmptyState icon={<Type size={20} />} title="Select a clip" hint="Text effects apply to the selected clip." />
        </div>
      )}
    </div>
  );
}
