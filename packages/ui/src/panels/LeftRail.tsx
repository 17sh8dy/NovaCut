import { FolderOpen, Sparkles, Wand2, Type, Music, Captions } from 'lucide-react';
import { useStore, useAppStore } from '../state/context.js';
import type { PanelId } from '../state/store.js';
import { Panel } from '../components/primitives/index.js';
import { MediaLibrary } from './MediaLibrary.js';
import { EffectsPanel, TransitionsPanel, TextPanel, PlaceholderPanel } from './BrowserPanels.js';

const RAIL: { id: PanelId; label: string; icon: typeof FolderOpen }[] = [
  { id: 'media', label: 'Media', icon: FolderOpen },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Trans', icon: Wand2 },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'captions', label: 'Captions', icon: Captions },
];

const TITLES: Record<PanelId, string> = {
  media: 'Media Library',
  effects: 'Effects',
  transitions: 'Transitions',
  text: 'Text',
  audio: 'Audio',
  captions: 'Captions',
};

/** The icon rail that switches the adjacent browser panel. */
export function LeftRail() {
  const store = useAppStore();
  const active = useStore((s) => s.activePanel);
  return (
    <div className="oc-rail">
      {RAIL.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className="oc-rail__btn"
          data-active={active === id}
          onClick={() => store.getState().setActivePanel(id)}
        >
          <Icon size={19} />
          {label}
        </button>
      ))}
    </div>
  );
}

/** The browser panel whose content follows the active rail selection. */
export function BrowserPanel() {
  const active = useStore((s) => s.activePanel);
  return (
    <Panel title={TITLES[active]} className="oc-grow">
      {active === 'media' && <MediaLibrary />}
      {active === 'effects' && <EffectsPanel />}
      {active === 'transitions' && <TransitionsPanel />}
      {active === 'text' && <TextPanel />}
      {active === 'audio' && (
        <PlaceholderPanel title="Audio Library" hint="Background music & sound effects live here" />
      )}
      {active === 'captions' && (
        <PlaceholderPanel title="Captions" hint="Auto-generate and SRT import aren't built yet" />
      )}
    </Panel>
  );
}
