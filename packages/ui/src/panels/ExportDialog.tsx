import { useMemo, useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import {
  CONTAINER_CODECS,
  FRAME_RATES,
  RESOLUTIONS,
  defaultBitrateMbps,
  defaultExportSettings,
  estimateFileSize,
  estimateRenderTime,
  findMedia,
  formatBytes,
  formatDuration,
  toSeconds,
  type Container,
  type ExportProgress,
  type ExportSettings,
  type QualityPreset,
  type Resolution,
  type VideoCodec,
} from '@opencut/core';
import { Button, Modal } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';

const QUALITIES: QualityPreset[] = ['low', 'medium', 'high', 'ultra'];
const CONTAINERS: Container[] = ['mp4', 'mov', 'mkv', 'avi', 'gif'];

/** The professional export window: resolution, fps, codec, quality, estimates, and queue. */
export function ExportDialog() {
  const store = useAppStore();
  const seq = useStore((s) => s.sequence());
  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(seq.fps));
  const [filename, setFilename] = useState(seq.name.replace(/\s+/g, '_'));
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  const durationSec = toSeconds(seq.duration) || 1;
  const patch = (p: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...p }));

  // Keep codec valid for the chosen container.
  const codecs = CONTAINER_CODECS[settings.container];
  const activeCodec = codecs.includes(settings.videoCodec) ? settings.videoCodec : codecs[0]!;

  const effectiveBitrate =
    settings.bitrateMbps ?? defaultBitrateMbps(settings.resolution, settings.quality, settings.fps);
  const sizeBytes = useMemo(() => estimateFileSize({ ...settings, bitrateMbps: effectiveBitrate }, durationSec), [settings, effectiveBitrate, durationSec]);
  const renderSec = useMemo(() => estimateRenderTime(settings, durationSec), [settings, durationSec]);

  const chooseLocation = async () => {
    const path = await store.getState().bridge.chooseExportPath(`${filename}.${settings.container}`);
    if (path) setOutputPath(path);
  };

  const startExport = async () => {
    const bridge = store.getState().bridge;
    let path = outputPath;
    if (!path) {
      path = await bridge.chooseExportPath(`${filename}.${settings.container}`);
      if (!path) return;
      setOutputPath(path);
    }
    const job = {
      id: `job_${Date.now()}`,
      sequenceId: seq.id,
      filename: `${filename}.${settings.container}`,
      outputPath: path,
      settings: { ...settings, videoCodec: activeCodec },
      createdAt: Date.now(),
    };
    setProgress({ jobId: job.id, status: 'rendering', progress: 0 });
    try {
      // Frame production (shared) → encoder (platform-specific). Same compositor as preview.
      const { OfflineExporter, renderSequenceAudioWav } = await import('@opencut/engine');
      const project = store.getState().project;
      const resolveUrl = (src: string) => bridge.resolveMediaUrl(src);
      // Mix the sequence audio offline (null if the timeline is silent), then mux it in.
      const audioWav = await renderSequenceAudioWav(seq, (id) => findMedia(project, id as never), resolveUrl).catch(
        () => null,
      );
      // Render + encode at the sequence resolution; ffmpeg scales to the chosen output size.
      const encoder = await bridge.createEncoder(job, { width: seq.width, height: seq.height, audioWav });
      const exporter = new OfflineExporter(project, seq, resolveUrl, seq.width, seq.height);
      await exporter.run(encoder, settings.fps, (info) => {
        setProgress({
          jobId: job.id,
          status: 'rendering',
          progress: info.progress,
          etaSeconds: info.etaSeconds,
          renderedFrames: info.renderedFrames,
          totalFrames: info.totalFrames,
        });
      });
      setProgress({ jobId: job.id, status: 'done', progress: 1 });
      store.getState().notify('Export complete', 'success');
    } catch (err) {
      setProgress({ jobId: job.id, status: 'error', progress: 0, message: String(err) });
      store.getState().notify('Export failed', 'error');
    }
  };

  const { width, height } = RESOLUTIONS[settings.resolution];

  return (
    <Modal
      title="Export Video"
      onClose={() => store.getState().openDialog(null)}
      footer={
        <>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {width}×{height} · {activeCodec.toUpperCase()} · {effectiveBitrate} Mbps
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => store.getState().openDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Download size={16} />} onClick={startExport} disabled={progress?.status === 'rendering'}>
              {progress?.status === 'rendering' ? 'Exporting…' : 'Export'}
            </Button>
          </div>
        </>
      }
    >
      <div className="oc-export-grid">
        <div className="oc-export-field">
          <label>Resolution</label>
          <select value={settings.resolution} onChange={(e) => patch({ resolution: e.target.value as Resolution })}>
            {(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => (
              <option key={r} value={r}>
                {r} ({RESOLUTIONS[r].width}×{RESOLUTIONS[r].height})
              </option>
            ))}
          </select>
        </div>
        <div className="oc-export-field">
          <label>Frame Rate</label>
          <select value={settings.fps} onChange={(e) => patch({ fps: +e.target.value })}>
            {FRAME_RATES.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>

        <div className="oc-export-field">
          <label>Container</label>
          <select value={settings.container} onChange={(e) => patch({ container: e.target.value as Container })}>
            {CONTAINERS.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="oc-export-field">
          <label>Codec</label>
          <select value={activeCodec} onChange={(e) => patch({ videoCodec: e.target.value as VideoCodec })}>
            {codecs.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="oc-export-field" style={{ gridColumn: '1 / -1' }}>
          <label>Quality</label>
          <div className="oc-pills">
            {QUALITIES.map((q) => (
              <button key={q} className="oc-pill" data-active={settings.quality === q} onClick={() => patch({ quality: q, bitrateMbps: undefined })}>
                {q[0]!.toUpperCase() + q.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="oc-export-field">
          <label>Bitrate (Mbps)</label>
          <input type="number" value={effectiveBitrate} min={1} onChange={(e) => patch({ bitrateMbps: +e.target.value })} />
        </div>
        <div className="oc-export-field">
          <label>Audio Bitrate (kbps)</label>
          <select value={settings.audioBitrateKbps} onChange={(e) => patch({ audioBitrateKbps: +e.target.value })}>
            {[128, 192, 256, 320].map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </select>
        </div>

        <div className="oc-export-field">
          <label>Filename</label>
          <input type="text" value={filename} onChange={(e) => setFilename(e.target.value)} style={{ cursor: 'text' }} />
        </div>
        <div className="oc-export-field">
          <label>Location</label>
          <button className="oc-btn" onClick={chooseLocation} style={{ justifyContent: 'flex-start', overflow: 'hidden' }}>
            <FolderOpen size={15} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {outputPath ?? 'Choose…'}
            </span>
          </button>
        </div>

        <label className="oc-export-field" style={{ gridColumn: '1 / -1', flexDirection: 'row', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.hardwareAcceleration}
            onChange={(e) => patch({ hardwareAcceleration: e.target.checked })}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>Hardware acceleration (GPU encoding when available)</span>
        </label>
      </div>

      <div className="oc-estimate">
        <div className="oc-estimate__item">
          <span className="oc-estimate__label">Estimated Size</span>
          <span className="oc-estimate__value">{formatBytes(sizeBytes)}</span>
        </div>
        <div className="oc-estimate__item">
          <span className="oc-estimate__label">Render Time</span>
          <span className="oc-estimate__value">~{formatDuration(renderSec)}</span>
        </div>
        <div className="oc-estimate__item">
          <span className="oc-estimate__label">Duration</span>
          <span className="oc-estimate__value">{formatDuration(durationSec)}</span>
        </div>
      </div>

      {progress && (
        <div className="oc-queue-item">
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
            <span>{filename}.{settings.container}</span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {progress.status === 'rendering' ? `${Math.round(progress.progress * 100)}%` : progress.status}
              {progress.etaSeconds != null && ` · ${formatDuration(progress.etaSeconds)} left`}
            </span>
          </div>
          <div className="oc-progress">
            <div className="oc-progress__fill" style={{ width: `${progress.progress * 100}%` }} />
          </div>
          {progress.message && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{progress.message}</span>}
        </div>
      )}
    </Modal>
  );
}
