import { useEffect, useState } from 'react';
import { frameSnapshot, type FrameSnapshot } from '../state/frameStats.js';
import { useStore } from '../state/context.js';

/**
 * A small frame-rate readout in the corner of the preview (Settings > Experimental > FPS overlay).
 *
 * Reports frames the preview actually drew and how long they took to draw, sampled a few times a
 * second. The text size is the person's choice but is clamped here as well as in the setting, so a
 * hand-edited preference can never make it big enough to cover the picture.
 */
export function FpsOverlay() {
  const size = useStore((s) => s.preferences.fpsOverlaySize);
  const [snap, setSnap] = useState<FrameSnapshot>({ fps: 0, avgMs: 0 });

  useEffect(() => {
    const id = window.setInterval(() => setSnap(frameSnapshot()), 250);
    return () => window.clearInterval(id);
  }, []);

  const px = Math.max(10, Math.min(18, Number(size) || 12));
  return (
    <div className="oc-fps" style={{ fontSize: px }} aria-hidden="true">
      {snap.fps > 0 ? (
        <>
          <strong>{snap.fps}</strong> fps · {snap.avgMs.toFixed(1)} ms
        </>
      ) : (
        <>idle</>
      )}
    </div>
  );
}
