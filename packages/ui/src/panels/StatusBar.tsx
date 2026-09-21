import { useEffect, useState } from 'react';
import { Magnet, Film, Layers } from 'lucide-react';
import { formatTimecode } from '@opencut/core';
import { useStore } from '../state/context.js';

/** Zoom as "30 px/s", with decimals only when zoomed so far out that rounding would say "0". */
const formatPps = (pps: number) => (pps >= 10 ? `${Math.round(pps)}` : pps >= 1 ? pps.toFixed(1) : pps.toFixed(2));

/**
 * Developer mode's extra readout: JS heap and page size. `performance.memory` is Chromium-only
 * (which is all this app runs on), so it is read defensively rather than assumed.
 */
function DevDiagnostics() {
  const [text, setText] = useState('');
  useEffect(() => {
    const read = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const heap = mem ? `${Math.round(mem.usedJSHeapSize / 1048576)} MB heap` : 'heap n/a';
      setText(`${heap} · ${document.getElementsByTagName('*').length} nodes · F12 DevTools`);
    };
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{text}</span>;
}

/** Bottom status bar: sequence spec, selection, zoom, and playhead readout. */
export function StatusBar() {
  const seq = useStore((s) => s.sequence());
  const selectedCount = useStore((s) => s.selectedClipIds.length);
  const pps = useStore((s) => s.pixelsPerSecond);
  const snap = useStore((s) => s.snapEnabled);
  const playhead = useStore((s) => s.playhead);
  const developerMode = useStore((s) => s.preferences.developerMode);
  const clipCount = seq.tracks.reduce((n, t) => n + t.clips.length, 0);

  return (
    <div className="oc-statusbar">
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Film size={12} /> {seq.width}×{seq.height} · {seq.fps} fps
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Layers size={12} /> {seq.tracks.length} tracks · {clipCount} clips
      </span>
      {selectedCount > 0 && <span>{selectedCount} selected</span>}
      <span style={{ flex: 1 }} />
      {developerMode && <DevDiagnostics />}
      {snap && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-hover)' }}>
          <Magnet size={12} /> Snap
        </span>
      )}
      <span>{formatPps(pps)} px/s</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
        {formatTimecode(playhead, seq.fps)}
      </span>
    </div>
  );
}
