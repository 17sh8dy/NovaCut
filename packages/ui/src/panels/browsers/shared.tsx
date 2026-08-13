/**
 * Shared furniture for the effect/filter/animation browsers.
 *
 * The three shelves added here — Filters, Text Animations, Text Effects — plus the two that
 * already existed hold well over two hundred entries between them. The thing that decides
 * whether that is a library or a junk drawer is not how the items are implemented, it is
 * whether the same four affordances (search, categories, favourites, recents) work identically
 * everywhere. So they live here once rather than being re-invented per panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, X } from 'lucide-react';

/** Where a shelf keeps its favourites and recents. One namespace per shelf. */
export type Shelf = 'effects' | 'filters' | 'text-anim' | 'text-fx' | 'transitions';

const FAV_KEY = (shelf: Shelf) => `opencut.favorites.${shelf}`;
const RECENT_KEY = (shelf: Shelf) => `opencut.recent.${shelf}`;
const RECENT_MAX = 8;

function readList(key: string): string[] {
  // Never let a corrupt or hand-edited entry take the panel down with it — an unreadable
  // favourites list should cost the favourites, not the browser.
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* Quota or a locked-down profile. Losing the list is survivable; throwing here is not. */
  }
}

/**
 * Favourites and recents for one shelf, persisted across sessions.
 *
 * Deliberately localStorage rather than the project file: which effects a person reaches for is
 * a fact about the person, not about the edit. Baking it into the project would mean a shared
 * project imposed its author's habits on whoever opened it next.
 */
export function useShelfMemory(shelf: Shelf) {
  const [favorites, setFavorites] = useState<string[]>(() => readList(FAV_KEY(shelf)));
  const [recents, setRecents] = useState<string[]>(() => readList(RECENT_KEY(shelf)));

  const toggleFavorite = useCallback(
    (id: string) => {
      setFavorites((prev) => {
        const next = prev.includes(id) ? prev.filter((f) => f !== id) : [id, ...prev];
        writeList(FAV_KEY(shelf), next);
        return next;
      });
    },
    [shelf],
  );

  const markUsed = useCallback(
    (id: string) => {
      setRecents((prev) => {
        const next = [id, ...prev.filter((r) => r !== id)].slice(0, RECENT_MAX);
        writeList(RECENT_KEY(shelf), next);
        return next;
      });
    },
    [shelf],
  );

  return { favorites, recents, toggleFavorite, markUsed };
}

/** The search field every shelf puts above its grid. */
export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="oc-browser__search">
      <Search size={14} />
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        // Escape clears rather than blurring: with a filtered grid on screen, "get me back to
        // everything" is what the key is being pressed for.
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <button className="oc-browser__clear" onClick={() => onChange('')} title="Clear search">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The category strip.
 *
 * Scrolls horizontally rather than wrapping, because a strip that changes height as the labels
 * reflow makes the grid below it jump every time the panel is resized.
 */
export function CategoryTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="oc-browser__tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          data-active={t.value === value}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One catalog entry: a preview, a name, and a favourite toggle.
 *
 * The star is a real button inside the chip's click target, so it stops propagation — clicking
 * a star must not also apply the effect, which is the single most annoying way to get this
 * wrong.
 */
export function ItemChip({
  label,
  title,
  favorite,
  applied,
  onToggleFavorite,
  onClick,
  onPointerEnter,
  onPointerLeave,
  children,
  draggable,
  onDragStart,
}: {
  label: string;
  title: string;
  favorite: boolean;
  /** Currently in effect on the selection. Shelves where "applied" is not a state omit it. */
  applied?: boolean;
  onToggleFavorite: () => void;
  onClick: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      className="oc-chip oc-chip--item"
      data-applied={applied ? 'true' : undefined}
      title={title}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      draggable={draggable}
      onDragStart={onDragStart}
    >
      <button className="oc-chip__hit" onClick={onClick} aria-label={label}>
        <div className="oc-chip__preview">{children}</div>
        <span className="oc-chip__label">{label}</span>
      </button>
      <button
        className="oc-chip__fav"
        data-on={favorite}
        aria-label={favorite ? `Remove ${label} from favourites` : `Add ${label} to favourites`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star size={12} fill={favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

/** A labelled run of chips. Renders nothing at all when empty, so sections self-hide. */
export function ChipSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="oc-section-title">{title}</div>
      <div className="oc-chip-grid">{children}</div>
    </div>
  );
}

/**
 * Order a catalog for display: favourites first, then recents, then everything else.
 *
 * Returns the three buckets separately rather than one sorted array so the panel can label
 * them. Items are never duplicated across buckets — a favourite that is also recent shows up
 * only under Favourites, because seeing the same chip twice in one scroll reads as a bug.
 */
export function bucket<T>(
  items: T[],
  idOf: (item: T) => string,
  favorites: string[],
  recents: string[],
): { favorite: T[]; recent: T[]; rest: T[] } {
  const favSet = new Set(favorites);
  const favorite = items.filter((i) => favSet.has(idOf(i)));
  const recentSet = new Set(recents.filter((r) => !favSet.has(r)));
  const recent = recents
    .map((r) => items.find((i) => idOf(i) === r))
    .filter((i): i is T => !!i && recentSet.has(idOf(i)));
  const used = new Set([...favorites, ...recentSet]);
  return { favorite, recent, rest: items.filter((i) => !used.has(idOf(i))) };
}

/** Case-insensitive substring match over a few fields. */
export const matches = (query: string, ...fields: (string | undefined)[]): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
};

/**
 * Drive a 0..1 progress value with requestAnimationFrame while `active`.
 *
 * Used by the animation chips to preview themselves by running the REAL `apply()` function
 * rather than a CSS impression of it. That matters more than it sounds: a hand-written CSS
 * approximation is a second implementation of the animation that nobody updates, so the chip
 * slowly stops telling the truth about what clicking it will do. Here the preview cannot drift,
 * because it is the same code the compositor runs.
 *
 * Only the hovered chip animates, so this is one rAF loop at a time, not seventy-five.
 */
export function usePreviewClock(
  active: boolean,
  seconds: number,
  loop: boolean,
  /**
   * The progress an idle chip sits at.
   *
   * This has to differ per lane or half the grid renders blank. An entrance rests at 1 — it has
   * arrived. An exit rests at 0 — it has not left yet. Parking both at 1 would leave every
   * un-hovered exit chip showing a title that has already faded, slid off, or scaled to nothing,
   * i.e. an empty box.
   */
  rest: number,
): number {
  const [progress, setProgress] = useState(rest);
  const raf = useRef(0);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(raf.current);
      setProgress(rest);
      return;
    }
    const start = performance.now();
    const dur = Math.max(0.05, seconds) * 1000;
    const tick = (now: number) => {
      const elapsed = now - start;
      // A beat of rest between repeats: an entrance that restarts the instant it lands never
      // shows the user what "landed" looks like.
      const cycle = loop ? dur : dur + 450;
      const t = (elapsed % cycle) / dur;
      setProgress(Math.min(1, t));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [active, seconds, loop, rest]);

  return progress;
}

/** Stable empty-result copy, so every shelf says the same thing. */
export function NoResults({ query }: { query: string }) {
  return (
    <div className="oc-browser__none">
      No matches for “{query}”.
    </div>
  );
}

/** Shared hook: current search text plus a memoised filter helper. */
export function useSearch<T>(items: T[], predicate: (item: T, query: string) => boolean) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => (query.trim() ? items.filter((i) => predicate(i, query)) : items),
    [items, query, predicate],
  );
  return { query, setQuery, filtered };
}
