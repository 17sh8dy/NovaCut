/**
 * The Filters browser — one-click looks for video, grouped by mood.
 *
 * Filters are ordinary effects (see `filters.ts`), so applying one is the same dispatch the
 * Effects panel makes and everything downstream — the inspector's Intensity slider, keyframing,
 * undo, export — comes along for free.
 */

import { useMemo, useState } from 'react';
import { Film } from 'lucide-react';
import {
  allFilters,
  instantiateEffect,
  unpackColor,
  updateClip,
  type EffectDefinition,
  type FilterCategory,
} from '@opencut/core';
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
import { EmptyState } from '../../components/primitives/index.js';

type Tab = FilterCategory | 'all';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'basic', label: 'Basic' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'color', label: 'Color' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'creative', label: 'Creative' },
  { value: 'bw', label: 'B&W' },
];

/**
 * A swatch showing roughly what the grade does, derived from the filter's own constants.
 *
 * CSS filters cover the global moves (exposure, contrast, saturation, hue) but have no notion
 * of split toning, which is most of what distinguishes one cinematic look from another. So the
 * shadow and highlight tints are painted as two soft gradient washes over the test image — an
 * approximation, but one that reproduces the single most identifying feature of each look, and
 * enough to tell Teal & Orange from Moonlight at a glance.
 *
 * It is explicitly not a render of the user's actual frame. Running thirty GPU grades of the
 * current frame to populate a scrolling grid would cost far more than it tells anyone.
 */
function FilterSwatch({ def }: { def: EffectDefinition }) {
  const k = def.constants ?? {};
  const css = [
    `brightness(${(1 + (k.exposure ?? 0) * 0.45).toFixed(3)})`,
    `contrast(${(1 + (k.contrast ?? 0) * 0.85).toFixed(3)})`,
    `saturate(${Math.max(0, 1 + (k.saturation ?? 0) + (k.vibrance ?? 0) * 0.5).toFixed(3)})`,
    (k.hue ?? 0) !== 0 ? `hue-rotate(${k.hue}deg)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const toning = k.toning ?? 0;
  const shadow = unpackColor(k.shadowTint ?? 0x808080);
  const highlight = unpackColor(k.highlightTint ?? 0x808080);
  // Temperature has no CSS equivalent; a warm/cool wash over the whole swatch is the honest
  // stand-in, and it is the same visual cue the tints use.
  const temp = k.temperature ?? 0;

  return (
    <div className="oc-filtprev" aria-hidden>
      <div className="oc-filtprev__img" style={{ filter: css }} />
      {toning > 0.001 && (
        <>
          <div
            className="oc-filtprev__wash"
            style={{ background: `linear-gradient(160deg, transparent 45%, ${shadow})`, opacity: toning * 0.55 }}
          />
          <div
            className="oc-filtprev__wash"
            style={{ background: `linear-gradient(160deg, ${highlight} , transparent 55%)`, opacity: toning * 0.45 }}
          />
        </>
      )}
      {Math.abs(temp) > 0.001 && (
        <div
          className="oc-filtprev__wash"
          style={{ background: temp > 0 ? '#ff9a3c' : '#4c8dff', opacity: Math.abs(temp) * 0.28 }}
        />
      )}
      {(k.fade ?? 0) > 0.001 && (
        <div className="oc-filtprev__wash" style={{ background: '#b9b6ad', opacity: (k.fade ?? 0) * 0.5 }} />
      )}
      {(k.vignette ?? 0) > 0.001 && (
        <div
          className="oc-filtprev__wash"
          style={{ background: 'radial-gradient(circle, transparent 35%, #000)', opacity: (k.vignette ?? 0) * 0.75 }}
        />
      )}
    </div>
  );
}

export function FiltersPanel() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const { favorites, recents, toggleFavorite, markUsed } = useShelfMemory('filters');

  const selectedId = useStore((s) => s.selectedClipIds[0]);

  const items = useMemo(
    () =>
      allFilters()
        .filter((d) => tab === 'all' || d.filter === tab)
        .filter((d) => matches(query, d.label, d.filter, d.type)),
    [tab, query],
  );
  const { favorite, recent, rest } = bucket(items, (d) => d.type, favorites, recents);

  const apply = (type: string) => {
    const state = store.getState();
    const id = selectedId;
    if (!id) return state.notify('Select a clip first', 'info', 'Filters apply to the selected clip.');
    const seq = state.sequence();
    const instance = instantiateEffect(type);
    state.dispatch({
      label: 'Add Filter',
      apply: (p) => updateClip(p, seq.id, id, (c) => ({ ...c, effects: [...c.effects, instance] })),
    });
    markUsed(type);
    state.setInspectorTab('effects');
    state.notify('Filter applied', 'success');
  };

  const chip = (def: EffectDefinition) => (
    <ItemChip
      key={def.type}
      label={def.label}
      title={`${def.label} — click to apply. Adjust with the Intensity slider in the inspector.`}
      favorite={favorites.includes(def.type)}
      onToggleFavorite={() => toggleFavorite(def.type)}
      onClick={() => apply(def.type)}
    >
      <FilterSwatch def={def} />
    </ItemChip>
  );

  return (
    <div className="oc-browser">
      <CategoryTabs tabs={TABS} value={tab} onChange={setTab} />
      <SearchBox value={query} onChange={setQuery} placeholder="Search filters" />

      <div className="oc-browser__scroll">
        {items.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <>
            <ChipSection title="Favourites" count={favorite.length}>{favorite.map(chip)}</ChipSection>
            <ChipSection title="Recent" count={recent.length}>{recent.map(chip)}</ChipSection>
            <ChipSection
              title={favorite.length || recent.length ? 'All' : TABS.find((t) => t.value === tab)!.label}
              count={rest.length}
            >
              {rest.map(chip)}
            </ChipSection>
          </>
        )}
      </div>

      {!selectedId && (
        <div className="oc-browser__hint">
          <EmptyState icon={<Film size={20} />} title="Select a clip" hint="Filters apply to the selected clip." />
        </div>
      )}
    </div>
  );
}
