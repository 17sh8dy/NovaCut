import { useEffect, useMemo, useState } from 'react';
import { Film, ImageIcon, Music, Search, Upload, Loader2, X } from 'lucide-react';
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
      // Ask the picker for footage and audio only. Stills belong to the Photo Editor, which
      // has layers, masks and text — everything that makes a still worth editing — while this
      // timeline could only stretch one across five seconds.
      const files = await store.getState().bridge.importDialog(['video', 'audio', 'image']);
      if (files.length === 0) return; // user canceled
      await ingest(files.map((f) => ({ src: f.src, name: f.name, mime: f.mime, size: f.size })));
    } catch (err) {
      store.getState().notify('Import failed', 'error', String(err));
    }
  };

  // File → Import Media (and Ctrl+I) enter the editor with this flag set; open the dialog here.
  const pendingImport = useStore((s) => s.pendingImport);
  useEffect(() => {
    if (pendingImport) {
      store.getState().setPendingImport(false);
      void runImport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImport]);

  /*
   * Home's "Import Media" is different: it already ran the picker, decided from the chosen files
   * that this was the right workspace, and routed here. Re-opening a dialog would ask the user
   * the same question twice — so these files skip the picker and go straight into ingest.
   */
  const pendingFiles = useStore((s) => s.pendingFiles);
  useEffect(() => {
    if (pendingFiles?.target !== 'editor') return;
    const { files } = pendingFiles;
    store.getState().setPendingFiles(null);
    void ingest(files.map((f) => ({ src: f.src, name: f.name, mime: f.mime, size: f.size })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles]);

  /**
   * Turn imported file descriptors into probed MediaAssets, streaming progress.
   *
   * Still images are now ordinary media: they sit on the timeline as clips (5 seconds to start,
   * stretchable to any length). Only GIFs are still turned away, because the timeline would draw
   * a GIF as one frozen frame; the message names the Photo Editor so the refusal is not a dead end.
   */
  const ingest = async (files: { src: string; name: string; mime: string; size: number }[]) => {
    if (files.length === 0) return;
    const gifs = files.filter((f) => isGifFile(f.mime, f.name));
    if (gifs.length > 0) {
      files = files.filter((f) => !isGifFile(f.mime, f.name));
      const names = gifs.slice(0, 3).map((f) => f.name).join(', ');
      store.getState().notify(
        gifs.length === 1 ? 'GIFs open in the Photo Editor' : `${gifs.length} GIFs skipped`,
        'info',
        `${names}${gifs.length > 3 ? '…' : ''} — use Home → Photo Editor for GIFs.`,
      );
      if (files.length === 0) return;
    }
    const bridge = store.getState().bridge;
    const assets: MediaAsset[] = [];
    /** Files whose probe failed — almost always "no ffprobe on PATH". Reported at the end. */
    const unreadable: string[] = [];
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
          // A still has no source length: 0 lets the clip be stretched to any duration.
          duration: kind === 'image' ? 0 : seconds(probe.duration || 0),
          width: probe.width,
          height: probe.height,
          ...(probe.fps !== undefined ? { fps: probe.fps } : {}),
          hasAudio: probe.hasAudio,
          ...(thumbnail ? { thumbnail } : {}),
          fileSize: f.size,
          importedAt: Date.now() + i,
        });
      } catch {
        /*
         * The probe failed, which on a clean machine means one thing: no ffprobe on PATH.
         *
         * The asset is still added — a file the user just chose vanishing without trace is worse,
         * and the preview does not actually need FFmpeg since Chromium decodes H.264 itself. What
         * we cannot know is the duration or the real dimensions, so those are placeholders and
         * the clip will behave oddly on the timeline.
         *
         * The failure is now COLLECTED rather than swallowed. It used to be silent, and the toast
         * below still said "Imported 1 file" in success green — so a first run without FFmpeg
         * looked like it had worked, produced a zero-length clip with invented dimensions, and
         * put nothing on screen connecting the two.
         */
        unreadable.push(f.name);
        assets.push({
          id: newMediaId(),
          kind,
          name: f.name,
          src: f.src,
          duration: 0,
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

    if (unreadable.length === 0) {
      store.getState().notify(`Imported ${assets.length} file${assets.length > 1 ? 's' : ''}`, 'success');
      return;
    }

    // Name the cause and the fix. "Import failed" alone sends the user to inspect their file.
    const names = unreadable.slice(0, 3).join(', ') + (unreadable.length > 3 ? '…' : '');
    store.getState().notify(
      unreadable.length === assets.length
        ? `Could not read ${unreadable.length === 1 ? 'that file' : 'those files'}`
        : `${unreadable.length} of ${assets.length} files could not be read`,
      'error',
      `${names} — Nova Cut needs FFmpeg to read duration and dimensions, to make thumbnails, and ` +
        'to export. Install it and make sure ffmpeg and ffprobe are on your PATH, then re-import.',
    );
  };

  /**
   * Remove assets from the library. Nova Cut only — the files stay on disk.
   *
   * Confirmed first because it is not a free action: clips built from the asset are removed from
   * the timeline with it, so this can delete visible work. Undo covers it, but a prompt naming
   * the consequence is cheaper than discovering it.
   */
  const removeFromLibrary = (ids: string[], label: string) => {
    if (ids.length === 0) return;
    const usedBy = store
      .getState()
      .project.sequences.flatMap((seq) => seq.tracks.flatMap((t) => t.clips))
      .filter((c) => c.mediaId !== undefined && ids.includes(c.mediaId)).length;
    const detail = usedBy > 0 ? ` and ${usedBy} clip${usedBy > 1 ? 's' : ''} using it from the timeline` : '';
    const ok = window.confirm(
      `Remove ${label} from this project${detail}?

The file stays on your device — this only removes it from Nova Cut.`,
    );
    if (!ok) return;
    store.getState().removeMedia(ids);
    store.getState().notify(`Removed ${label} from the project`, 'success', 'The file on your device was not touched.');
  };

  /** Only OS files count; dragging a card out of the library toward the timeline must not light this up. */
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  const ingestFiles = async (list: File[]) => {
    const bridge = store.getState().bridge;
    const files = list;
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

  const onDrop = async (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragOver(false);
    await ingestFiles([...e.dataTransfer.files]);
  };

  /*
   * Files copied in Explorer (Ctrl+C) paste straight in with Ctrl+V while the library is on
   * screen. Only a paste that actually carries files is taken: text pastes, and the timeline's own
   * clip paste (which never touches the system clipboard), are left alone — as is any paste into
   * a text field.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      void ingestFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="oc-media-panel"
      data-drag={dragOver}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Leaving for a child is not leaving the panel.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="oc-media-dropveil" aria-hidden="true">
          <Upload size={28} />
          <span>Drop to add to your media</span>
        </div>
      )}
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
                or drop or paste video, audio, images & GIFs
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
                  /* Delete/Backspace on a focused card, for anyone who reaches for the key first. */
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                    e.preventDefault();
                    const ids = selected.includes(m.id) ? selected : [m.id];
                    removeFromLibrary(ids, ids.length > 1 ? `${ids.length} items` : m.name);
                  }}
                  title={m.name}
                >
                  <div className="oc-media-card__thumb">
                    {m.thumbnail ? <img src={m.thumbnail} alt="" /> : <Icon size={26} />}
                    {m.duration > 0 && <span className="oc-media-card__badge">{formatClock(m.duration)}</span>}
                    {/*
                      Removes from the library, not from the disk — the wording in the confirm and
                      the toast carries that, since a bare X on a file is easy to read as "delete".
                      stopPropagation so the click does not also select or open the asset.
                    */}
                    <button
                      className="oc-media-card__remove"
                      title={`Remove ${m.name} from the project (your file is not deleted)`}
                      aria-label={`Remove ${m.name} from the project`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromLibrary([m.id], m.name);
                      }}
                    >
                      <X size={13} />
                    </button>
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

function isGifFile(mime: string, name: string): boolean {
  return mime === 'image/gif' || name.toLowerCase().endsWith('.gif');
}

function mimeToKind(mime: string, name: string): MediaKind {
  const lower = name.toLowerCase();
  if (mime.startsWith('audio/') || /\.(mp3|wav|aac|flac|ogg|m4a)$/.test(lower)) return 'audio';
  if (lower.endsWith('.gif') || mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?)$/.test(lower)) return 'image';
  return 'video';
}
