/**
 * PhotoEditor — the photo workspace.
 *
 * A tool rail and dock on the left, the canvas in the middle, the inspector on the right, with
 * a title bar above and a status bar below. Everything it draws with is shared: the primitives
 * and theme come from the design system, the effects come from core's registry, and the canvas
 * is the engine's photo render graph. What is photo-specific is only the document it edits.
 *
 * This file is a composition and nothing else. Every behaviour lives in the panel that owns it
 * — interaction in `photo/CanvasStage`, the tree in `photo/LayersPanel`, and so on. That split
 * is what let this go from a single 575-line file that could only show sliders to a workspace
 * with direct manipulation, without any one file growing unreadable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FilePlus2,
  History as HistoryIcon,
  ImagePlus,
  Layers as LayersIcon,
  Ratio,
  Redo2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { Layer, PhotoDocument } from '@opencut/photo';
import { renameDocument, rotateCanvas } from '@opencut/photo';
import { Button, IconButton, Panel, ResizablePanels } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { usePhoto, usePhotoStore } from '../state/photoContext.js';
import { clearAutosave, readAutosave, writeAutosave, type PhotoAutosave, type PhotoDock } from '../state/photoStore.js';
import { usePhotoEngine, type PhotoEngine } from '../state/usePhotoEngine.js';
import { AssetsPanel } from './photo/AssetsPanel.js';
import { CanvasStage } from './photo/CanvasStage.js';
import { HistoryPanel } from './photo/HistoryPanel.js';
import { InspectorPanel } from './photo/InspectorPanel.js';
import { LayersPanel } from './photo/LayersPanel.js';
import { naturalSizeOf } from './photo/layerGeometry.js';
import { CanvasSizeDialog, ExportPhotoDialog, NewCanvasDialog } from './photo/PhotoDialogs.js';
import { OptionsBar, ToolRail } from './photo/ToolRail.js';
import { WindowControls } from './WindowControls.js';
import { usePhotoShortcuts } from './photo/usePhotoShortcuts.js';
import './photo.css';

export function PhotoEditor() {
  const engine = usePhotoEngine();
  const store = usePhotoStore();
  const dialog = usePhoto((s) => s.dialog);
  usePhotoShortcuts(store);
  useAutosave();
  usePendingImport(store);

  return (
    <div className="app-shell">
      <PhotoTitleBar engine={engine} />
      <OptionsBar />
      <div className="oc-workspace oc-workspace--photo">
        <ToolRail />
        <ResizablePanels direction="horizontal" initial={[1, 3.4, 1.15]} min={[220, 320, 280]}>
          <Dock />
          <CanvasStage engine={engine} />
          <Panel title="Inspector">
            <InspectorPanel />
          </Panel>
        </ResizablePanels>
      </div>
      <PhotoStatusBar />
      <RestorePrompt />

      {dialog === 'newCanvas' && <NewCanvasDialog />}
      {dialog === 'canvasSize' && <CanvasSizeDialog />}
      {dialog === 'export' && <ExportPhotoDialog engine={engine} />}
    </div>
  );
}

/**
 * Take delivery of files Home already picked.
 *
 * Home runs the file dialog before choosing a workspace — a .png routes here, a .mp4 to the
 * timeline — so the selection arrives as app state rather than through this editor's own picker.
 * Cleared before ingesting so a re-render cannot import the same files twice, and the `target`
 * check means the timeline's share of a mixed selection is never consumed here by mistake.
 */
function usePendingImport(store: ReturnType<typeof usePhotoStore>): void {
  const app = useAppStore();
  const pendingFiles = useStore((s) => s.pendingFiles);
  useEffect(() => {
    if (pendingFiles?.target !== 'photo') return;
    const { files } = pendingFiles;
    app.getState().setPendingFiles(null);
    void store.getState().importChosen(files);
  }, [pendingFiles, app, store]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Title bar
// ─────────────────────────────────────────────────────────────────────────────

function PhotoTitleBar({ engine }: { engine: PhotoEngine }) {
  const app = useAppStore();
  const store = usePhotoStore();
  const name = usePhoto((s) => s.doc.name);
  const importing = usePhoto((s) => s.importing);
  const layerCount = usePhoto((s) => s.doc.layers.length);
  // Subscribing to the history version is what re-evaluates the undo/redo buttons: History's
  // canUndo/canRedo are plain getters React cannot observe, but every edit, undo and redo bumps
  // the counter, so reading the getters during a counter-driven render keeps them honest.
  usePhoto((s) => s.historyVersion);
  const canUndo = store.getState().history.canUndo;
  const canRedo = store.getState().history.canRedo;

  const [editingName, setEditingName] = useState(false);

  // Read the doc at click time rather than subscribing to it: this bar re-renders on the name and
  // the history counter, and subscribing to the whole document here would re-render the title bar
  // on every brush stroke.
  const turnCanvas = (turns: 1 | 2 | 3) => {
    const s = store.getState();
    s.dispatch(rotateCanvas(turns, (l: Layer) => naturalSizeOf(l, s.doc)));
  };

  return (
    <div className="oc-titlebar oc-photobar">
      <button className="oc-btn" onClick={() => app.getState().setView('home')} title="Back to Home">
        <ArrowLeft size={16} /> Home
      </button>

      {editingName ? (
        <input
          className="oc-photobar__nameinput"
          autoFocus
          defaultValue={name}
          onBlur={(e) => {
            store.getState().dispatch(renameDocument(e.target.value.trim() || name));
            setEditingName(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditingName(false);
          }}
        />
      ) : (
        <button className="oc-photobar__name" onClick={() => setEditingName(true)} title="Rename">
          {name}
        </button>
      )}

      <div className="oc-photobar__spacer" />

      <IconButton onClick={() => store.getState().undo()} disabled={!canUndo} title="Undo  (Ctrl Z)">
        <Undo2 size={16} />
      </IconButton>
      <IconButton onClick={() => store.getState().redo()} disabled={!canRedo} title="Redo  (Ctrl Shift Z)">
        <Redo2 size={16} />
      </IconButton>
      <IconButton onClick={() => store.getState().setDialog('newCanvas')} title="New canvas  (Ctrl N)">
        <FilePlus2 size={16} />
      </IconButton>
      <IconButton onClick={() => store.getState().setDialog('canvasSize')} title="Canvas size">
        <Ratio size={16} />
      </IconButton>
      {/*
        Canvas rotation lives in the bar, not only in the Inspector's Canvas section, because
        "how do I rotate this" is a question people ask of the toolbar first. The Inspector holds
        the full set (180°, both flips); these two are the ones reached for.
      */}
      <IconButton onClick={() => turnCanvas(3)} title="Rotate canvas 90° left">
        <RotateCcw size={16} />
      </IconButton>
      <IconButton onClick={() => turnCanvas(1)} title="Rotate canvas 90° right">
        <RotateCw size={16} />
      </IconButton>
      <Button onClick={() => void store.getState().importImages()} disabled={importing}>
        <ImagePlus size={16} /> {importing ? 'Importing…' : 'Add Image'}
      </Button>
      <Button
        variant="primary"
        onClick={() => store.getState().setDialog('export')}
        disabled={layerCount === 0}
        title="Export  (Ctrl E)"
      >
        <Download size={16} /> Export
      </Button>
      {/* Kept so the title bar's simplest path — one click, PNG, current size — stays one
          click even though the dialog exists. */}
      <IconButton
        title="Quick export PNG"
        disabled={layerCount === 0}
        onClick={() => void quickPng(engine, name, app)}
      >
        <Download size={14} />
      </IconButton>

      {/*
        App settings, reachable from HERE and not only from Home. SettingsDialog is mounted in
        AppRoot above the view switch precisely so it can open over this workspace — but until
        now that capability had no entry point in the photo editor, so the only way to change a
        preference mid-session was to abandon the document and go back to Home. Same icon and
        same position as the video title bar's, so "settings is the slider icon on the right"
        holds in every view.
      */}
      <IconButton title="Settings" aria-label="Settings" onClick={() => app.getState().openDialog('settings')}>
        <SlidersHorizontal size={16} />
      </IconButton>

      <WindowControls />
    </div>
  );
}

async function quickPng(engine: PhotoEngine, name: string, app: ReturnType<typeof useAppStore>) {
  const blob = await engine.toPng();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name || 'photo'}.png`;
  a.click();
  URL.revokeObjectURL(url);
  app.getState().notify('Exported PNG', 'success', a.download);
}

// ─────────────────────────────────────────────────────────────────────────────
// Left dock
// ─────────────────────────────────────────────────────────────────────────────

const DOCKS: { id: PhotoDock; label: string; icon: typeof LayersIcon }[] = [
  { id: 'layers', label: 'Layers', icon: LayersIcon },
  { id: 'assets', label: 'Assets', icon: Sparkles },
  { id: 'history', label: 'History', icon: HistoryIcon },
];

/**
 * One dock, three tabs, rather than three stacked panels.
 *
 * Layers, assets and history are all "the list on the left", and only one of them is ever the
 * thing you are looking at. Stacking them would spend vertical space on two panels the user is
 * ignoring — and vertical space in the layers panel is the scarcest thing in the workspace.
 */
function Dock() {
  const store = usePhotoStore();
  const dock = usePhoto((s) => s.dock);
  return (
    <Panel>
      <div className="oc-dock">
        <div className="oc-dock__tabs">
          {DOCKS.map((d) => (
            <button key={d.id} data-active={dock === d.id} onClick={() => store.getState().setDock(d.id)}>
              <d.icon size={14} /> {d.label}
            </button>
          ))}
        </div>
        <div className="oc-dock__body">
          {dock === 'layers' && <LayersPanel />}
          {dock === 'assets' && <AssetsPanel />}
          {dock === 'history' && <HistoryPanel />}
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

function PhotoStatusBar() {
  const doc = usePhoto((s) => s.doc);
  const zoom = usePhoto((s) => s.viewport.zoom);
  const selection = usePhoto((s) => s.selection);
  const dirty = usePhoto((s) => s.dirty);
  const count = useMemo(() => countLayers(doc), [doc]);

  return (
    <div className="oc-statusbar oc-statusbar--photo">
      <span>{doc.width} × {doc.height}</span>
      <span className="oc-statusbar__sep" />
      <span>{count} layer{count === 1 ? '' : 's'}</span>
      {selection.length > 0 && (
        <>
          <span className="oc-statusbar__sep" />
          <span>{selection.length} selected</span>
        </>
      )}
      <div className="oc-statusbar__spacer" />
      {dirty && <span className="oc-statusbar__dot" title="Unsaved changes" />}
      <span>{Math.round(zoom * 100)}%</span>
    </div>
  );
}

function countLayers(doc: PhotoDocument): number {
  let n = 0;
  const visit = (layers: PhotoDocument['layers']) => {
    for (const l of layers) {
      n++;
      if (l.kind === 'group') visit(l.children);
    }
  };
  visit(doc.layers);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Autosave & restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the document to local storage shortly after it stops changing.
 *
 * Debounced rather than throttled: a slider drag produces a document per pointermove, and
 * serialising a hundred-layer tree on each one would be the most expensive thing in the frame.
 * Waiting for the pause means one write per *edit*, which is what "autosave" should cost.
 */
function useAutosave() {
  const store = usePhotoStore();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe((s, prev) => {
      if (s.doc === prev.doc) return;
      clearTimeout(timer);
      timer = setTimeout(() => writeAutosave(store.getState().doc), 1200);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [store]);
}

/**
 * Offered once at startup when a previous session left work behind.
 *
 * Shown rather than restored silently: the autosave holds media *references*, so a document
 * whose images came from a pasted screenshot restores with those layers unresolvable. Naming
 * what is on offer lets the user decide whether it is worth having.
 */
function RestorePrompt() {
  const store = usePhotoStore();
  const [offer, setOffer] = useState<PhotoAutosave | null>(null);
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    // Only offer when the current session has nothing in it — interrupting someone who has
    // already started work to ask about older work is the wrong trade.
    if (store.getState().doc.layers.length > 0) return;
    setOffer(readAutosave());
  }, [store]);

  if (!offer) return null;
  return (
    <div className="oc-recovery" role="dialog" aria-label="Restore photo session">
      <div className="oc-recovery__body">
        <strong>Restore your last photo?</strong>
        <span>
          “{offer.name}” from {new Date(offer.savedAt).toLocaleString()} — {countLayers(offer.doc)} layers.
        </span>
      </div>
      <div className="oc-recovery__actions">
        <button
          className="oc-btn"
          onClick={() => {
            clearAutosave();
            setOffer(null);
          }}
        >
          Discard
        </button>
        <button
          className="oc-btn oc-btn--primary"
          onClick={() => {
            store.getState().loadDocument(offer.doc);
            setOffer(null);
          }}
        >
          Restore
        </button>
      </div>
    </div>
  );
}
