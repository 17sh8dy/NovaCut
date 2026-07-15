import { useEffect, useMemo, useState } from 'react';
import { Film, ImageIcon, Music, Search, Upload, Loader2 } from 'lucide-react';
import {
  formatClock,
  newMediaId,
  seconds,
  type MediaAsset,
  type MediaKind,
} from '@opencut/core';
import { dlog } from '@opencut/engine';
import { EmptyState } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';

const KIND_ICON: Record<MediaKind, typeof Film> = {
  video: Film,
  image: ImageIcon,
  gif: ImageIcon,
  audio: Music,
};

/** Media library: import button, drag-drop zone, search/sort, and a thumbnail grid. */
export function MediaLibrary() {
  const store = useAppStore();
  const media = useStore((s) => s.project.media);
  const search = useStore((s) => s.search);
  const selected = useStore((s) => s.selectedMediaIds);
  const importProgress = useStore((s) => s.importProgress);
  const [dragOver, setDragOver] = useState(false);
  const [sort, setSort] = useState<'name' | 'recent' | 'kind'>('recent');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = media.filter((m) => (q ? m.name.toLowerCase().includes(q) : true));
    return [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'kind') return a.kind.localeCompare(b.kind);
      return b.importedAt - a.importedAt;
    });
  }, [media, search, sort]);

  const runImport = async () => {
    try {
      const files = await store.getState().bridge.importDialog();
      if (files.length === 0) return; // user canceled
      await ingest(files.map((f) => ({ src: f.src, name: f.name, mime: f.mime, size: f.size })));
    } catch (err) {
      store.getState().notify('Import failed', 'error', String(err));
    }
  };

  // Home's "Import Media" enters the editor with this flag set; open the dialog once, here.
  const pendingImport = useStore((s) => s.pendingImport);
  useEffect(() => {
    if (pendingImport) {
      store.getState().setPendingImport(false);
      void runImport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImport]);

  /** Turn imported file descriptors into probed MediaAssets, streaming progress. */
  const ingest = async (files: { src: string; name: string; mime: string; size: number }[]) => {
    if (files.length === 0) return;
    const bridge = store.getState().bridge;
    const assets: MediaAsset[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      store.getState().setImportProgress({ total: files.length, done: i, currentFile: f.name });
      const kind = mimeToKind(f.mime, f.name);
      dlog('import', 'ingest file', {
        name: f.name,
        kind,
        mime: f.mime,
        src: f.src,
        srcScheme: /^([a-z]+):/i.exec(f.src)?.[1] ?? '(bare path)',
        isBlobFallback: f.src.startsWith('blob:'),
      });
      try {
        const probe = await bridge.probeMedia(f.src);
        dlog('import', 'probe result', { name: f.name, duration: probe.duration, w: probe.width, h: probe.height, fps: probe.fps, hasAudio: probe.hasAudio });
        const thumbnail = kind !== 'audio' ? await bridge.generateThumbnail(f.src).catch((e) => { dlog('import', 'thumbnail FAILED', { name: f.name, err: String(e) }); return undefined; }) : undefined;
        assets.push({
          id: newMediaId(),
          kind,
          name: f.name,
          src: f.src,
          duration: seconds(probe.duration || (kind === 'image' ? 5 : 0)),
          width: probe.width,
          height: probe.height,
          ...(probe.fps !== undefined ? { fps: probe.fps } : {}),
          hasAudio: probe.hasAudio,
          ...(thumbnail ? { thumbnail } : {}),
          fileSize: f.size,
          importedAt: Date.now() + i,
        });
      } catch {
        // Probe failed (missing ffprobe?): still add the asset so the user sees it.
        assets.push({
          id: newMediaId(),
          kind,
          name: f.name,
          src: f.src,
          duration: kind === 'image' ? seconds(5) : 0,
          width: 1920,
          height: 1080,
          hasAudio: kind === 'audio' || kind === 'video',
          fileSize: f.size,
          importedAt: Date.now() + i,
        });
      }
    }
    store.getState().addMedia(assets);
    store.getState().setImportProgress(null);
    store.getState().notify(`Imported ${assets.length} file${assets.length > 1 ? 's' : ''}`, 'success');
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const bridge = store.getState().bridge;
    const files = [...e.dataTransfer.files];
    await ingest(
      files.map((f) => ({
        // Prefer a durable path (desktop) so probing/thumbnails/export work; fall back to
        // an in-memory object URL on platforms that don't expose one.
        src: bridge.resolveDroppedFile(f) ?? URL.createObjectURL(f),
        name: f.name,
        mime: f.type,
        size: f.size,
      })),
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="oc-search">
        <Search size={14} />
        <input
          placeholder="Search media…"
          value={search}
          onChange={(e) => store.getState().setSearch(e.target.value)}
        />
      </div>

      <div className="oc-import-zone">
        <button
          className="oc-import-btn"
          data-drag={dragOver}
          onClick={runImport}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {importProgress ? (
            <>
              <Loader2 size={24} className="oc-spin" />
              <span style={{ fontWeight: 600 }}>
                Importing {importProgress.done + 1}/{importProgress.total}
              </span>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                {importProgress.currentFile}
              </span>
            </>
          ) : (
            <>
              <Upload size={24} />
              <span style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>Import Media</span>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                or drop video, audio, images & GIFs
              </span>
            </>
          )}
        </button>
      </div>

      {media.length > 0 && (
        <div className="oc-section-title">
          <span>{filtered.length} items</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <option value="recent">Recent</option>
            <option value="name">Name</option>
            <option value="kind">Type</option>
          </select>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {media.length === 0 ? (
          <EmptyState icon={<Film size={40} />} title="No media yet" hint="Import files to get started" />
        ) : (
          <div className="oc-media-grid">
            {filtered.map((m) => {
              const Icon = KIND_ICON[m.kind];
              return (
                <div
                  key={m.id}
                  className="oc-media-card"
                  data-selected={selected.includes(m.id)}
                  draggable
                  onClick={() => store.getState().selectMedia([m.id])}
                  onDoubleClick={() => store.getState().addMediaToTimeline(m)}
                  onDragStart={(e) => e.dataTransfer.setData('application/x-opencut-media', m.id)}
                  title={m.name}
                >
                  <div className="oc-media-card__thumb">
                    {m.thumbnail ? <img src={m.thumbnail} alt="" /> : <Icon size={26} />}
                    {m.duration > 0 && <span className="oc-media-card__badge">{formatClock(m.duration)}</span>}
                  </div>
                  <div className="oc-media-card__name">{m.name}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function mimeToKind(mime: string, name: string): MediaKind {
  const lower = name.toLowerCase();
  if (mime.startsWith('audio/') || /\.(mp3|wav|aac|flac|ogg|m4a)$/.test(lower)) return 'audio';
  if (lower.endsWith('.gif') || mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?)$/.test(lower)) return 'image';
  return 'video';
}
