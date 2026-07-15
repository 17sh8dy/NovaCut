import { Magnet, Film, Layers } from 'lucide-react';
import { formatTimecode } from '@opencut/core';
import { useStore } from '../state/context.js';

/** Bottom status bar: sequence spec, selection, zoom, and playhead readout. */
export function StatusBar() {
  const seq = useStore((s) => s.sequence());
  const selectedCount = useStore((s) => s.selectedClipIds.length);
  const pps = useStore((s) => s.pixelsPerSecond);
  const snap = useStore((s) => s.snapEnabled);
  const playhead = useStore((s) => s.playhead);
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
      {snap && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-hover)' }}>
          <Magnet size={12} /> Snap
        </span>
      )}
      <span>{Math.round(pps)} px/s</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
        {formatTimecode(playhead, seq.fps)}
      </span>
    </div>
  );
}
