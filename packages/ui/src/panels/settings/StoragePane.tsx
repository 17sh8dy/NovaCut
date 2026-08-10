/**
 * Storage — what Open Cut is actually using on disk.
 *
 * Every figure is measured, not estimated: the host walks the real directories and reports byte
 * totals. A storage page that guesses is worse than no storage page, because the number it shows
 * is the one thing a user will act on ("I'll clear that 14 GB") and the action has to match.
 *
 * Measuring is deliberately kicked off on mount rather than cached: cache sizes change constantly
 * and a stale figure would be shown as fact.
 */

import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../components/primitives/index.js';
import { useAppStore } from '../../state/context.js';
import type { StorageUsage } from '@opencut/core';

const LABELS: Record<keyof StorageUsage['buckets'], { title: string; desc: string }> = {
  cache: { title: 'Cache', desc: 'GPU shader cache and Chromium’s own caches. Safe to clear — all of it is regenerated on demand.' },
  projects: { title: 'Projects', desc: 'Your .opencut files in the default project folder.' },
  autosaves: { title: 'Autosaves', desc: 'Recovery snapshots written while you edit, including the thumbnails stored inside them.' },
  logs: { title: 'Preferences & logs', desc: 'Settings, the recent-project list, window state and diagnostics.' },
};

function human(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function StoragePane() {
  const store = useAppStore();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [clearing, setClearing] = useState(false);

  const measure = useCallback(async () => {
    const { bridge, preferences } = store.getState();
    if (!bridge.storageUsage) return setState('unavailable');
    setState('loading');
    try {
      setUsage(await bridge.storageUsage(preferences.defaultProjectDir));
      setState('ready');
    } catch {
      setState('unavailable');
    }
  }, [store]);

  useEffect(() => { void measure(); }, [measure]);

  if (state === 'unavailable') {
    return <p className="oc-setting-note">Storage details aren’t available on this platform.</p>;
  }

  const total = usage ? Object.values(usage.buckets).reduce((s, v) => s + v, 0) : 0;
  const largest = usage ? Math.max(1, ...Object.values(usage.buckets)) : 1;

  return (
    <>
      <div className="oc-storage__head">
        <div>
          <div className="oc-storage__total">{state === 'loading' ? 'Measuring…' : human(total)}</div>
          <div className="oc-storage__totallabel">used by Open Cut</div>
        </div>
        <Button variant="ghost" icon={<RefreshCw size={14} />} disabled={state === 'loading'} onClick={() => void measure()}>
          Recalculate
        </Button>
      </div>

      <div className="oc-storage__list">
        {(Object.keys(LABELS) as (keyof StorageUsage['buckets'])[]).map((key) => {
          const bytes = usage?.buckets[key] ?? 0;
          return (
            <div key={key} className="oc-storage__row">
              <div className="oc-storage__row-head">
                <span className="oc-storage__name">{LABELS[key].title}</span>
                <span className="oc-storage__size">{state === 'loading' ? '—' : human(bytes)}</span>
              </div>
              {/* Bars are scaled to the LARGEST bucket, not to the total: with one bucket at 90%
                  every other bar would be a hairline and the comparison they exist for is lost. */}
              <div className="oc-storage__bar">
                <span style={{ width: `${state === 'loading' ? 0 : (bytes / largest) * 100}%` }} data-key={key} />
              </div>
              <div className="oc-storage__desc">{LABELS[key].desc}</div>
            </div>
          );
        })}
      </div>

      <div className="oc-setting-actions">
        <Button
          variant="ghost"
          icon={<Trash2 size={14} />}
          disabled={clearing || state === 'loading'}
          onClick={async () => {
            setClearing(true);
            try {
              const freed = await store.getState().bridge.clearCache?.();
              store.getState().notify(
                'Cache cleared',
                'success',
                typeof freed === 'number' ? `${human(freed)} freed` : undefined,
              );
              await measure();
            } finally {
              setClearing(false);
            }
          }}
        >
          {clearing ? 'Clearing…' : 'Clear cache'}
        </Button>
        <span className="oc-setting-note" style={{ margin: 0 }}>
          Clearing the cache never touches your projects — only files Open Cut can regenerate.
        </span>
      </div>

      {usage?.dataDir && (
        <p className="oc-setting-note">
          <HardDrive size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          {usage.dataDir}
        </p>
      )}
    </>
  );
}
