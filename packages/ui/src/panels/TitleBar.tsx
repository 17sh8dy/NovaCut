import {
  Download,
  Redo2,
  Save,
  Settings,
  SlidersHorizontal,
  Undo2,
  Scissors,
  FilePlus2,
  FolderOpen,
} from 'lucide-react';
import { Button, IconButton, Tooltip } from '../components/primitives/index.js';
import { useAppStore, useStore } from '../state/context.js';
import { AppMenuBar } from './AppMenuBar.js';
import { WindowControls } from './WindowControls.js';

/** Top application bar: brand, project state, global actions, export. */
export function TitleBar() {
  const store = useAppStore();
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.history.canUndo);
  const canRedo = useStore((s) => s.history.canRedo);

  return (
    <div className="oc-titlebar">
      <button className="oc-brand" onClick={() => store.getState().setView('home')} title="Back to Home">
        <div className="oc-brand__mark" />
        Open&nbsp;Cut
      </button>

      <AppMenuBar />

      <div className="oc-menu-row">
        <Tooltip label="New Project" shortcut="Ctrl N">
          <IconButton
            onClick={async () => {
              if (!(await store.getState().guardUnsaved())) return;
              store.getState().newProject();
            }}
          >
            <FilePlus2 size={17} />
          </IconButton>
        </Tooltip>
        <Tooltip label="Open Project" shortcut="Ctrl O">
          <IconButton
            onClick={async () => {
              if (!(await store.getState().guardUnsaved())) return;
              const res = await store.getState().bridge.openProjectDialog();
              if (res) store.getState().loadProjectData(res.project, res.path);
            }}
          >
            <FolderOpen size={17} />
          </IconButton>
        </Tooltip>
        <Tooltip label="Save" shortcut="Ctrl S">
          <IconButton onClick={() => store.getState().save()}>
            <Save size={17} />
          </IconButton>
        </Tooltip>
      </div>

      <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

      <div className="oc-menu-row">
        <Tooltip label="Undo" shortcut="Ctrl Z">
          <IconButton disabled={!canUndo} onClick={() => store.getState().undo()}>
            <Undo2 size={17} />
          </IconButton>
        </Tooltip>
        <Tooltip label="Redo" shortcut="Ctrl ⇧ Z">
          <IconButton disabled={!canRedo} onClick={() => store.getState().redo()}>
            <Redo2 size={17} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="oc-titlebar__project">
        <Scissors size={13} />
        {name}
        {dirty && <span className="oc-titlebar__dot" title="Unsaved changes" />}
      </div>

      <div className="oc-titlebar__spacer" />

      <Tooltip label="Settings">
        <IconButton onClick={() => store.getState().openDialog('settings')}>
          <SlidersHorizontal size={17} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Project Settings">
        <IconButton onClick={() => store.getState().openDialog('projectSettings')}>
          <Settings size={17} />
        </IconButton>
      </Tooltip>
      <Button variant="primary" icon={<Download size={16} />} onClick={() => store.getState().openDialog('export')}>
        Export
      </Button>

      <WindowControls />
    </div>
  );
}
