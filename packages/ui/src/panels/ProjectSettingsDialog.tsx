import { updateSequence } from '@opencut/core';
import { Button, Modal } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';

const RES_PRESETS = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '4K', width: 3840, height: 2160 },
  { label: '9:16', width: 1080, height: 1920 },
  { label: '1:1', width: 1080, height: 1080 },
];

/**
 * Project + sequence settings: resolution, fps, autosave, editing behaviour.
 *
 * Theme used to live here too, and it was the wrong place twice over: it is an application
 * preference, not a property of a video (open a colleague's project and it would repaint your
 * editor), and it wrote `data-theme` directly, so it silently fought useAppliedPreferences and
 * lost the moment any other preference changed. It now lives only in Settings → General.
 */
export function ProjectSettingsDialog() {
  const store = useAppStore();
  const seq = useStore((s) => s.sequence());

  const setRes = (width: number, height: number) => {
    store.getState().dispatch({
      label: 'Sequence Size',
      apply: (p) => updateSequence(p, p.activeSequenceId, (s) => ({ ...s, width, height })),
    });
  };
  const setFps = (fps: number) => {
    store.getState().dispatch({
      label: 'Frame Rate',
      apply: (p) => updateSequence(p, p.activeSequenceId, (s) => ({ ...s, fps })),
    });
  };

  return (
    <Modal title="Project Settings" onClose={() => store.getState().openDialog(null)} maxWidth={560}
      footer={<Button variant="primary" onClick={() => store.getState().openDialog(null)}>Done</Button>}>
      <div className="oc-export-field" style={{ marginBottom: 20 }}>
        <label>Resolution</label>
        <div className="oc-pills">
          {RES_PRESETS.map((r) => (
            <button key={r.label} className="oc-pill" data-active={seq.width === r.width && seq.height === r.height} onClick={() => setRes(r.width, r.height)}>
              {r.label} ({r.width}×{r.height})
            </button>
          ))}
        </div>
      </div>

      <div className="oc-export-field">
        <label>Frame Rate</label>
        <div className="oc-pills">
          {[24, 25, 30, 50, 60].map((f) => (
            <button key={f} className="oc-pill" data-active={seq.fps === f} onClick={() => setFps(f)}>
              {f} fps
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
