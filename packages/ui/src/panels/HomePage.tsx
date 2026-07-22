/**
 * Home launcher — the "Choose a workspace" screen shown before a project is open.
 *
 * Presents Open Cut's editors as a grid of workspace cards. The Video Editor is live and flips
 * the store's `view` to 'editor'; the others are staged (Coming soon) or roadmap (Future) and
 * are non-navigating for now. Below the chooser: quick actions, crash recovery, recent
 * projects, and info sections. Purely presentational + store actions — no engine/playback
 * involvement (the PlaybackProvider only mounts once the editor view is active).
 */

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Film,
  Image,
  Images,
  Music,
  Palette,
  Sparkles,
  Check,
  FolderOpen,
  Upload,
  Clock,
  LayoutTemplate,
  Lightbulb,
  Rocket,
  RotateCcw,
  ArrowRight,
} from 'lucide-react';
import type { RecentProject } from '@opencut/core';
import { useAppStore, useStore } from '../state/context.js';
import { AnimatedContent, GradientText, ShinyText, SpotlightCard } from '../components/animated/index.js';
import { AppMenuBar } from './AppMenuBar.js';
import { WindowControls } from './WindowControls.js';
import './home.css';

const TIPS = [
  'Press Ctrl+K to split the selected clip at the playhead.',
  'Hold Alt while dragging a clip to temporarily disable snapping.',
  'Ctrl + Mouse Wheel zooms the timeline in and out.',
  'Drag the red playhead to scrub; playback resumes from where you leave it.',
  'Customize any keyboard shortcut in Settings → Keyboard Shortcuts.',
];

const WHATS_NEW = [
  'Choose-a-workspace home with Video, Photo, GIF & Audio editors.',
  'Professional Settings window with a full keyboard-shortcut editor.',
  'Crash recovery — restore your session after an unexpected close.',
];

type WsStatus = 'live' | 'soon' | 'future';

interface Workspace {
  id: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  /** A token color var used to tint the card's icon, glow, and accents. */
  accent: string;
  status: WsStatus;
  /** Capability bullets (used by the AI Tools card). */
  features?: string[];
}

/** The workspaces on offer. Order = display order; only 'live' ones navigate. */
const WORKSPACES: Workspace[] = [
  {
    id: 'video',
    icon: Film,
    title: 'Video Editor',
    desc: 'Cut, trim and arrange video and audio on a timeline.',
    accent: 'var(--accent)',
    status: 'live',
    features: ['Multi-track timeline', 'Effects & transitions', 'Keyframe animation', 'Export to MP4'],
  },
  {
    id: 'photo',
    // The old line read "Stack GPU filters on layered images, non-destructively" — three pieces
    // of jargon and no mention of what you would actually MAKE. A workspace card has one job:
    // tell someone whether this is the room they want. Say the job, then list the tools.
    icon: Image,
    title: 'Photo Editor',
    desc: 'Edit photos and design thumbnails, banners and social posts.',
    accent: 'var(--label-blue)',
    status: 'live',
    features: [
      'Layers, masks & selections',
      'Text, shapes & ready-made presets',
      'Brushes, filters & adjustments',
      'Export PNG, JPG & WebP',
    ],
  },
  {
    id: 'gif',
    icon: Images,
    title: 'GIF Editor',
    desc: 'Create and optimize animated GIFs.',
    accent: 'var(--label-teal)',
    status: 'soon',
  },
  {
    id: 'audio',
    icon: Music,
    title: 'Audio Editor',
    desc: 'Trim audio, remove noise, and mix tracks.',
    accent: 'var(--label-pink)',
    status: 'soon',
  },
  {
    id: 'design',
    icon: Palette,
    title: 'Design Studio',
    desc: 'Create thumbnails, banners, and social graphics.',
    accent: 'var(--label-orange)',
    status: 'future',
  },
  {
    id: 'ai',
    icon: Sparkles,
    title: 'AI Tools',
    desc: 'A growing suite of AI-assisted editing.',
    accent: 'var(--label-purple)',
    status: 'future',
    features: ['Background removal', 'Auto captions', 'Object removal', 'Image generation', 'Voice enhancement'],
  },
];

const STATUS_LABEL: Record<Exclude<WsStatus, 'live'>, string> = {
  soon: 'Coming soon',
  future: 'Future',
};

export function HomePage() {
  const store = useAppStore();
  const recovery = useStore((s) => s.recovery);
  const [recents, setRecents] = useState<RecentProject[]>([]);

  useEffect(() => {
    let alive = true;
    store
      .getState()
      .bridge.recentProjects()
      .then((list) => alive && setRecents(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [store]);

  const enterEditor = () => store.getState().setView('editor');

  const openVideoEditor = () => {
    store.getState().newProject();
    enterEditor();
  };
  const openProject = async () => {
    const res = await store.getState().bridge.openProjectDialog();
    if (res) {
      store.getState().loadProjectData(res.project, res.path);
      enterEditor();
    }
  };
  const importMedia = () => {
    store.getState().newProject();
    store.getState().setPendingImport(true); // Media Library opens the import dialog on mount
    enterEditor();
  };
  const openRecent = async (path: string) => {
    try {
      const project = await store.getState().bridge.loadProject(path);
      store.getState().loadProjectData(project, path);
      enterEditor();
    } catch {
      store.getState().notify('Could not open project', 'error', path);
    }
  };
  const recover = () => {
    store.getState().restoreRecovery();
    enterEditor();
  };

  const selectWorkspace = (ws: Workspace) => {
    if (ws.id === 'video') openVideoEditor();
    else if (ws.id === 'photo') store.getState().setView('photo');
  };

  return (
    <div className="oc-home" data-theme-scope>
      <div className="oc-aurora" aria-hidden />
      {/*
        Home has no title bar of its own, but the window is frameless — without a drag strip here
        the app cannot be moved from its own start screen. It is a real row above the scroller
        rather than an overlay so cards can never scroll underneath it and stop being clickable.
      */}
      <div className="oc-home__chrome">
        <AppMenuBar />
        <WindowControls />
      </div>
      <div className="oc-home__scroll">
        {/* Hero */}
        <header className="oc-home__hero">
          <AnimatedContent direction="scale">
            <div className="oc-home__logo" />
          </AnimatedContent>
          <AnimatedContent delay={70}>
            <h1 className="oc-home__title">
              <GradientText>Open&nbsp;Cut</GradientText>
            </h1>
          </AnimatedContent>
          <AnimatedContent delay={130}>
            <p className="oc-home__tagline">
              <ShinyText>Choose a workspace</ShinyText>
            </p>
          </AnimatedContent>

          <AnimatedContent delay={190}>
            <div className="oc-home__actions">
              <button className="oc-home__btn oc-home__btn--sm" onClick={openProject}>
                <FolderOpen size={16} /> Open Project
              </button>
              <button className="oc-home__btn oc-home__btn--sm" onClick={importMedia}>
                <Upload size={16} /> Import Media
              </button>
            </div>
          </AnimatedContent>
        </header>

        {/* Workspace chooser */}
        <div className="oc-workspaces">
          {WORKSPACES.map((ws, i) => (
            <AnimatedContent key={ws.id} delay={230 + i * 55}>
              <WorkspaceCard ws={ws} onSelect={() => selectWorkspace(ws)} />
            </AnimatedContent>
          ))}
        </div>

        {/* Recover (only after an unclean shutdown) */}
        {recovery && (
          <AnimatedContent delay={140}>
            <section className="oc-home__recover">
              <div className="oc-home__recover-icon">
                <RotateCcw size={18} />
              </div>
              <div className="oc-home__recover-text">
                <strong>Recover autosaved project</strong>
                <span>
                  “{recovery.projectName}” from {new Date(recovery.savedAt).toLocaleString()} can be restored.
                </span>
              </div>
              <button className="oc-home__btn oc-home__btn--primary oc-shine" onClick={recover}>
                Restore <ArrowRight size={16} />
              </button>
            </section>
          </AnimatedContent>
        )}

        {/* Recent Projects */}
        <AnimatedContent delay={560}>
          <Section icon={Clock} title="Recent Projects">
            {recents.length === 0 ? (
              <p className="oc-home__empty">No recent projects yet. Open a workspace to get started.</p>
            ) : (
              <div className="oc-home__grid">
                {recents.map((r) => (
                  <SpotlightCard
                    key={r.path}
                    className="oc-home__card"
                    onClick={() => openRecent(r.path)}
                    title={r.path}
                  >
                    <div className="oc-home__card-thumb">
                      <LayoutTemplate size={22} />
                    </div>
                    <div className="oc-home__card-name">{r.name}</div>
                    <div className="oc-home__card-meta">{new Date(r.modifiedAt).toLocaleDateString()}</div>
                  </SpotlightCard>
                ))}
              </div>
            )}
          </Section>
        </AnimatedContent>

        <AnimatedContent delay={620}>
          <div className="oc-home__cols">
            <Section icon={Rocket} title="What's New">
              <ul className="oc-home__list">
                {WHATS_NEW.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Section>
            <Section icon={Lightbulb} title="Helpful Tips">
              <ul className="oc-home__list">
                {TIPS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </Section>
          </div>
        </AnimatedContent>
      </div>
    </div>
  );
}

/** A single workspace tile. The live one is an interactive, spotlit button; staged ones are
 *  muted cards with a status badge. */
function WorkspaceCard({ ws, onSelect }: { ws: Workspace; onSelect: () => void }) {
  const Icon = ws.icon;
  const style = { ['--ws-accent' as string]: ws.accent } as React.CSSProperties;

  const inner = (
    <>
      {ws.status !== 'live' && <span className="oc-ws-card__badge">{STATUS_LABEL[ws.status]}</span>}
      <div className="oc-ws-card__icon">
        <Icon size={26} />
      </div>
      <div className="oc-ws-card__title">{ws.title}</div>
      <div className="oc-ws-card__desc">{ws.desc}</div>
      {ws.features && (
        <ul className="oc-ws-card__features">
          {ws.features.map((f) => (
            <li key={f}>
              <Check size={13} /> {f}
            </li>
          ))}
        </ul>
      )}
      {ws.status === 'live' && (
        <div className="oc-ws-card__cta">
          Open <ArrowRight size={15} />
        </div>
      )}
    </>
  );

  if (ws.status === 'live') {
    return (
      <SpotlightCard className="oc-ws-card oc-ws-card--live oc-shine" style={style} onClick={onSelect}>
        {inner}
      </SpotlightCard>
    );
  }

  return (
    <div
      className={`oc-ws-card oc-ws-card--${ws.status}${ws.features ? ' oc-ws-card--wide' : ''}`}
      style={style}
      aria-disabled="true"
    >
      {inner}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: React.ReactNode }) {
  return (
    <section className="oc-home__section">
      <div className="oc-home__section-head">
        <Icon size={16} />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
