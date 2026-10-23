/**
 * The Transitions browser: Nova Cut's own transitions plus the open GL Transitions collection.
 *
 * Search, a Featured shelf, categories, favourites and recents, built from the same pieces as the
 * Filters and Text Animation shelves so it looks and behaves like them. Every chip is draggable
 * onto a cut (the timeline already understands that drop) and a click applies it at the playhead.
 *
 * ── Thumbnails ──────────────────────────────────────────────────────────────────────
 * Not CSS imitations and not live renders. Each transition has a strip of seven REAL frames,
 * rendered once at build time by the same shaders the editor uses (see
 * scripts/transition-sprites), packed into one image.  A resting chip shows its most telling
 * frame; the chip under the pointer steps through the strip. So a screen full of chips costs one
 * image decode and no GPU work, and only the hovered chip animates, which is what keeps a
 * 140-item grid from becoming a 140-item animation.
 */

import { useEffect, useMemo, useState } from 'react';
import { allTransitions, type TransitionDefinition } from '@opencut/core';
import { useAppStore } from '../../state/context.js';
import { applyTransitionAtTime } from '../Timeline.js';
import { bucket, CategoryTabs, ChipSection, ItemChip, matches, NoResults, SearchBox, useShelfMemory } from './shared.js';
import { SPRITE_FRAMES, SPRITE_ROWS, spriteRest, spriteRow } from './transitionSprites.generated.js';

const CATEGORY_ORDER = [
  'Dissolve & Fade',
  'Wipe & Slide',
  'Zoom & Rotate',
  '3D & Page',
  'Shapes & Reveals',
  'Glitch & Distort',
  'Light & Colour',
  'Pixel & Mosaic',
  'More',
];

type Tab = string;
const FEATURED = 'Featured';
const ALL = 'All';
const CLASSIC = 'Nova Classic';

/** Which tab a transition is listed under, beyond Featured / All. */
const tabOf = (t: TransitionDefinition): string => (t.gl ? (t.category ?? 'More') : CLASSIC);

/** One transition's frame strip. Steps through it only while `playing`. */
function TransitionThumb({ type, playing }: { type: string; playing: boolean }) {
  const row = spriteRow(type);
  const rest = spriteRest(type);
  const [frame, setFrame] = useState(rest);

  useEffect(() => {
    if (!playing) {
      setFrame(rest);
      return;
    }
    let i = 0;
    let dir = 1;
    setFrame(0);
    const timer = setInterval(() => {
      if (i >= SPRITE_FRAMES - 1) dir = -1;
      else if (i <= 0) dir = 1;
      i += dir;
      setFrame(i);
    }, 120);
    return () => clearInterval(timer);
  }, [playing, rest]);

  if (row === undefined) return <div className="oc-tthumb oc-tthumb--none" aria-hidden />;
  const x = SPRITE_FRAMES > 1 ? (frame / (SPRITE_FRAMES - 1)) * 100 : 0;
  const y = SPRITE_ROWS > 1 ? (row / (SPRITE_ROWS - 1)) * 100 : 0;
  return (
    <div
      className="oc-tthumb"
      aria-hidden
      style={{ backgroundSize: `${SPRITE_FRAMES * 100}% ${SPRITE_ROWS * 100}%`, backgroundPosition: `${x}% ${y}%` }}
    />
  );
}

export function TransitionsPanel() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>(FEATURED);
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const { favorites, recents, toggleFavorite, markUsed } = useShelfMemory('transitions');

  const everything = useMemo(() => allTransitions(), []);
  const tabs = useMemo(() => {
    const cats = [...new Set(everything.filter((t) => t.gl).map((t) => t.category ?? 'More'))].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
    );
    return [FEATURED, ALL, CLASSIC, ...cats].map((value) => ({ value, label: value }));
  }, [everything]);

  const items = useMemo(() => {
    const inTab = everything.filter((t) => {
      if (tab === ALL) return true;
      if (tab === FEATURED) return !!t.featured;
      return tabOf(t) === tab;
    });
    return inTab
      .filter((t) => matches(query, t.label, t.category, t.author, ...(t.tags ?? []), t.type))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [everything, tab, query]);
  const { favorite, recent, rest } = bucket(items, (t) => t.type, favorites, recents);

  /**
   * Click-to-apply: attach to the cut nearest the PLAYHEAD on the selected clip's track, or on
   * the first video track that has a cut at all. Drag onto a cut is the more precise path and
   * is handled by the timeline.
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
    markUsed(type);
  };

  const chip = (t: TransitionDefinition) => (
    <ItemChip
      key={t.type}
      label={t.label}
      title={`${t.label}${t.author ? ` — by ${t.author}` : ''}. Click to apply at the playhead, or drag onto a cut.`}
      favorite={favorites.includes(t.type)}
      onToggleFavorite={() => toggleFavorite(t.type)}
      onClick={() => apply(t.type)}
      onPointerEnter={() => setHovered(t.type)}
      onPointerLeave={() => setHovered((h) => (h === t.type ? null : h))}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-opencut-transition', t.type)}
    >
      <TransitionThumb type={t.type} playing={hovered === t.type} />
    </ItemChip>
  );

  const heading = tab === FEATURED ? 'Featured' : tab === ALL ? 'All transitions' : tab;
  const glCount = everything.filter((t) => t.gl).length;

  return (
    <div className="oc-browser">
      <CategoryTabs tabs={tabs} value={tab} onChange={setTab} />
      <SearchBox value={query} onChange={setQuery} placeholder="Search transitions" />

      <div className="oc-browser__scroll">
        {items.length === 0 ? (
          <NoResults query={query} />
        ) : (
          <>
            <ChipSection title="Favourites" count={favorite.length}>{favorite.map(chip)}</ChipSection>
            <ChipSection title="Recent" count={recent.length}>{recent.map(chip)}</ChipSection>
            <ChipSection title={favorite.length || recent.length ? heading : heading} count={rest.length}>
              {rest.map(chip)}
            </ChipSection>
          </>
        )}
        <p className="oc-browser__credit">
          {glCount} of these come from the open GL Transitions collection (MIT). Authors and licences are in
          Settings → About.
        </p>
      </div>
    </div>
  );
}
