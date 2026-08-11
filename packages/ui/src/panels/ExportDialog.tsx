import { useMemo, useRef, useState } from 'react';
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
  formatExportFilename,
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
import { readLastExport, writeLastExport } from '../state/exportMemory.js';

const QUALITIES: QualityPreset[] = ['low', 'medium', 'high', 'ultra'];
const CONTAINERS: Container[] = ['mp4', 'mov', 'mkv', 'avi', 'gif'];

/** The professional export window: resolution, fps, codec, quality, estimates, and queue. */
export function ExportDialog() {
  const store = useAppStore();
  const seq = useStore((s) => s.sequence());

  /*
   * Opening state, in precedence order: the library default, then the user's Export preferences,
   * then — only if "Remember last export settings" is on — whatever they actually ran last.
   *
   * Resolution and frame rate deliberately come from the SEQUENCE, not from either source: they
   * describe the thing being exported, and a remembered 4K would quietly upscale a 720p project.
   */
  const [settings, setSettings] = useState<ExportSettings>(() => {
    const p = store.getState().preferences;
    const base: ExportSettings = {
      ...defaultExportSettings(seq.fps),
      videoCodec: p.exportCodec as VideoCodec,
      hardwareAcceleration: p.exportHardware,
      bitrateMbps: p.exportVideoBitrate,
      audioBitrateKbps: Number(p.exportAudioBitrate) || 192,
    };
    return p.rememberExportSettings ? { ...base, ...readLastExport() } : base;
  });

  const [filename, setFilename] = useState(() => {
    const p = store.getState().preferences;
    // {resolution} and {fps} describe THIS export, so they come from the settings resolved just
    // above — not from the "default resolution" preference, which may not be what is being used.
    return formatExportFilename(p.exportFilenamePattern, {
      project: store.getState().project.name,
      resolution: settings.resolution,
      fps: settings.fps,
    });
  });
  const [outputPath, setOutputPath] = useState<string | null>(null);
  /**
   * The render in flight, so Cancel can actually stop it.
   *
   * A ref rather than state: nothing renders from it, and re-rendering the dialog on every
   * progress tick just to store a handle would be churn.
   */
  const running = useRef<{ abort: () => void } | null>(null);
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
    /*
     * Held outside the try so the catch can still reach it. An encoder is a live FFmpeg child
     * process with the output file open: if the render throws part-way, nothing else will ever
     * shut it down. `OfflineExporter.run` disposes the compositor and the frame pool in its own
     * finally, but it does not own the encoder and cannot close it. Without the abort below, a
     * failed export left ffmpeg.exe running until the app quit, still holding a truncated file
     * the user could not delete or overwrite.
     */
    let encoder: Awaited<ReturnType<typeof bridge.createEncoder>> | null = null;
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
      encoder = await bridge.createEncoder(job, { width: seq.width, height: seq.height, audioWav });
      const exporter = new OfflineExporter(project, seq, resolveUrl, seq.width, seq.height);
      running.current = exporter;
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
      /*
       * A cancelled run resolves normally — it is not a failure — so it has to be detected
       * rather than caught. Everything below this point announces a finished file and opens a
       * folder on it, and neither is true of an export the user stopped part-way.
       */
      if (exporter.cancelled) {
        setProgress(null);
        store.getState().notify('Export cancelled', 'info');
        return;
      }
      setProgress({ jobId: job.id, status: 'done', progress: 1 });
      const s2 = store.getState();
      s2.notify('Export complete', 'success');
      /*
       * Show the finished file in the file manager.
       *
       * Only on this branch, and only after `finish()` has resolved — an export that failed or
       * was cancelled goes to the catch below, and a truncated file is not something to go and
       * present to someone. The path is the one the encoder actually wrote, which is the export
       * folder from Settings whenever the user accepted the dialog's default location and the
       * right answer regardless when they did not.
       */
      s2.bridge.revealFile(path);
      // A system notification as well as the in-app toast: a render can take minutes and the
      // whole point is to be told while you are in another window.
      if (s2.preferences.notifyExport) s2.bridge.notify('Export complete', job.filename);
      if (s2.preferences.rememberExportSettings) writeLastExport({ ...settings, videoCodec: activeCodec });
    } catch (err) {
      // Kill the encoder before reporting, so the process is gone by the time the user reads the
      // message and goes to look at the file. Its own failure is swallowed: the export has
      // already failed, and "abort failed" on top of that tells the user nothing they can act on.
      await encoder?.abort().catch(() => {});
      setProgress({ jobId: job.id, status: 'error', progress: 0, message: String(err) });
      store.getState().notify('Export failed', 'error');
    } finally {
      running.current = null;
    }
  };

  /** Stop a render in flight; falls back to closing the dialog when nothing is running. */
  const cancel = () => {
    if (running.current) {
      running.current.abort();
      return;
    }
    store.getState().openDialog(null);
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
            <Button variant="ghost" onClick={cancel}>
              {progress?.status === 'rendering' ? 'Cancel Export' : 'Cancel'}
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
