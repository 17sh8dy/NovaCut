/**
 * Home launcher — the "Choose a workspace" screen shown before a project is open.
 *
 * Presents Nova Cut's editors as a grid of workspace cards. The Video Editor is live and flips
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
  Settings,
  Sparkles,
  FolderOpen,
  Upload,
  Clock,
  LayoutTemplate,
  Lightbulb,
  Rocket,
  RotateCcw,
  ArrowRight,
  Plus,
} from 'lucide-react';
import { isStillFile, type ImportedFile, type RecentProject } from '@opencut/core';
import { useAppStore, useStore } from '../state/context.js';
import { AnimatedContent, BrandText, CardButton } from '../components/animated/index.js';
import { AppMenuBar } from './AppMenuBar.js';
import { NovaSwitcher } from './NovaSwitcher.js';
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
  '125 new GL transitions, with adjustable settings and a searchable browser.',
  'Drag titles right in the preview to move them anywhere, with centre snapping.',
  'Clips no longer override each other — they move to a free track or a new one.',
  'Select several clips and drag them together as a group.',
  'Faster, smoother playback at high speeds, plus a Preview quality setting.',
  'Auto Ripple, still images on the video timeline, and update checks.',
];

type WsStatus = 'live' | 'soon' | 'future';

interface Workspace {
  id: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  /** A token colour var used to tint the card's icon tile — and nothing else on the card. */
  accent: string;
  status: WsStatus;
}

/** The workspaces on offer. Order = display order; only 'live' ones navigate. */
const WORKSPACES: Workspace[] = [
  {
    id: 'video',
    icon: Film,
    title: 'Video Editor',
    desc: 'Cut together films, vlogs, clips and highlight reels.',
    accent: 'var(--accent)',
    status: 'live',
  },
  {
    id: 'photo',
    // The old line read "Stack GPU filters on layered images, non-destructively" — three pieces
    // of jargon and no mention of what you would actually MAKE. A workspace card has one job:
    // tell someone whether this is the room they want. Say the job, then list the tools.
    icon: Image,
    title: 'Photo Editor',
    desc: 'Design thumbnails, banners, posters and social posts.',
    // The accent, like the Video card: a live workspace should follow the colour the person
    // chose. (It used a fixed label blue, so it stayed blue whatever the accent was.)
    // Nova's purple, so the two live workspaces read as a pair rather than twins.
    accent: 'var(--label-purple)',
    status: 'live',
  },
  // GIF Editor, Audio Editor and Design Studio were removed from the launcher on 2026-07-22.
  // A chooser that is mostly placeholders reads as an unfinished app, not an ambitious one — the
  // two workspaces that exist now carry the screen better on their own. Their `AppView` ids were
  // never wired to anything, so nothing was lost but the cards.
  {
    id: 'ai',
    icon: Sparkles,
    title: 'AI Tools',
    desc: 'AI-assisted editing, on the way.',
    // A muted violet: related to Photo's purple, clearly quieter.
    accent: 'color-mix(in srgb, var(--label-purple) 55%, var(--text-tertiary))',
    status: 'future',
  },
];

/** Recent projects shown before "View All"; the section grows as the list does. */
const RECENTS_SHOWN = 6;

const STATUS_LABEL: Record<Exclude<WsStatus, 'live'>, string> = {
  soon: 'Coming soon',
  future: 'Future',
};

export function HomePage() {
  const store = useAppStore();
  const recovery = useStore((s) => s.recovery);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [showAll, setShowAll] = useState(false);

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

  /*
   * Every card below that starts a DIFFERENT project asks about unsaved work first.
   *
   * Home is reachable from inside a session, not only at launch — the workspace stays loaded
   * behind it — so "New Video Project" here replaces real work exactly as Ctrl+N does.
   */
  const openVideoEditor = async () => {
    if (!(await store.getState().guardUnsaved())) return;
    store.getState().newProject();
    enterEditor();
  };
  const openProject = async () => {
    if (!(await store.getState().guardUnsaved())) return;
    const res = await store.getState().bridge.openProjectDialog();
    if (res) {
      store.getState().loadProjectData(res.project, res.path);
      enterEditor();
    }
  };
  /**
   * Pick files first, THEN pick the workspace that suits them.
   *
   * This used to head straight for the timeline and open the picker there, which made "Import
   * Media" quietly mean "import video": choosing a .png landed you in the video editor, where the
   * Media Library refused the still and told you to go to the Photo Editor instead. The file the
   * user chose is the clearest statement of intent available, so route on it.
   *
   * The dialog is unfiltered here for the same reason — at Home, before a workspace exists, every
   * supported file is a legitimate answer.
   */
  const importMedia = async () => {
    // Asked BEFORE the picker: this path ends in newProject(), and learning that the work was
    // about to be discarded only after choosing files is the question asked too late.
    if (!(await store.getState().guardUnsaved())) return;
    let files: ImportedFile[];
    try {
      files = await store.getState().bridge.importDialog();
    } catch (err) {
      store.getState().notify('Import failed', 'error', String(err));
      return;
    }
    if (files.length === 0) return; // user canceled

    const stills = files.filter((f) => isStillFile(f.mime, f.name));
    const footage = files.filter((f) => !isStillFile(f.mime, f.name));

    // A mixed selection cannot open in two places at once. Anything with footage in it opens in
    // the video editor, and the stills come along as image clips; only GIFs, which the timeline
    // would freeze on one frame, are named and left for the Photo Editor.
    if (footage.length > 0) {
      const isGif = (f: ImportedFile) => f.mime === 'image/gif' || f.name.toLowerCase().endsWith('.gif');
      const gifs = stills.filter(isGif);
      if (gifs.length > 0) {
        const names = gifs.slice(0, 3).map((f) => f.name).join(', ');
        store.getState().notify(
          gifs.length === 1 ? '1 GIF was left out' : `${gifs.length} GIFs were left out`,
          'info',
          `${names}${gifs.length > 3 ? '…' : ''} — open GIFs in the Photo Editor.`,
        );
      }
      store.getState().newProject();
      store.getState().setPendingFiles({ target: 'editor', files: [...footage, ...stills.filter((f) => !isGif(f))] });
      enterEditor();
      return;
    }

    store.getState().setPendingFiles({ target: 'photo', files: stills });
    store.getState().setView('photo');
  };
  const openRecent = async (path: string) => {
    if (!(await store.getState().guardUnsaved())) return;
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
      {/*
        Home has no title bar of its own, but the window is frameless — without a drag strip here
        the app cannot be moved from its own start screen. It is a real row above the scroller
        rather than an overlay so cards can never scroll underneath it and stop being clickable.
      */}
      <div className="oc-home__chrome">
        <AppMenuBar />
        <NovaSwitcher current="nova-cut" />
        <div className="oc-home__chrome-spacer" />
        <button
          className="oc-home__chrome-btn oc-home__chrome-btn--gear"
          onClick={() => store.getState().openDialog('settings')}
          title="Settings"
          aria-label="Settings"
        >
          {/*
            A gear, not the slider icon it used to be. Sliders read as "adjust these values";
            a cog is the near-universal sign for "this is where the settings are", and Home is
            the one screen a first-time user meets with no other context to go on.

            Deliberately NOT the flat blue of the reference image: the colour comes from theme
            tokens so it follows light/dark and the accent chosen in Settings → Appearance,
            which a baked-in gradient could not do.
          */}
          <Settings size={16} />
        </button>
        <WindowControls />
      </div>
      <div className="oc-home__scroll">
        <div className="oc-home__scroll-inner">
          {/* Hero */}
          <header className="oc-home__hero">
            <AnimatedContent direction="scale">
              <div className="oc-home__logo" />
            </AnimatedContent>
            <AnimatedContent delay={70}>
              <h1 className="oc-home__title">
                <BrandText>Nova&nbsp;Cut</BrandText>
              </h1>
            </AnimatedContent>
            <AnimatedContent delay={130}>
              <p className="oc-home__headline">Create something extraordinary.</p>
              <p className="oc-home__tagline">Your workspace for video, photography, and creative projects.</p>
            </AnimatedContent>

            <AnimatedContent delay={190}>
              <div className="oc-home__actions">
                <button className="oc-home__btn oc-home__btn--sm oc-home__btn--primary" onClick={() => void openVideoEditor()}>
                  <Plus size={16} /> New Project
                </button>
                <button className="oc-home__btn oc-home__btn--sm" onClick={openProject}>
                  <FolderOpen size={16} /> Open Project
                </button>
                <button className="oc-home__btn oc-home__btn--sm" onClick={() => void importMedia()}>
                  <Upload size={16} /> Import Media
                </button>
              </div>
            </AnimatedContent>
          </header>

          {/* Workspace chooser */}
          <h2 className="oc-home__label">Workspaces</h2>
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
                <button className="oc-home__btn oc-home__btn--primary" onClick={recover}>
                  Restore <ArrowRight size={16} />
                </button>
              </section>
            </AnimatedContent>
          )}

          {/* Recent Projects */}
          <AnimatedContent delay={560}>
            <Section
              icon={Clock}
              title="Recent Projects"
              action={
                recents.length > RECENTS_SHOWN ? (
                  <button className="oc-home__link" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show less' : `View All (${recents.length})`}
                  </button>
                ) : undefined
              }
            >
              {recents.length === 0 ? (
                <p className="oc-home__empty">No recent projects yet. Open a workspace to get started.</p>
              ) : (
                <div className="oc-home__grid">
                  {(showAll ? recents : recents.slice(0, RECENTS_SHOWN)).map((r) => (
                    <CardButton
                      key={r.path}
                      className="oc-home__card"
                      onClick={() => openRecent(r.path)}
                      title={r.path}
                    >
                      <div className="oc-home__card-thumb">
                        <LayoutTemplate size={28} />
                      </div>
                      <div className="oc-home__card-name">{r.name}</div>
                      <div className="oc-home__card-meta">Edited {new Date(r.modifiedAt).toLocaleDateString()}</div>
                    </CardButton>
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
    </div>
  );
}

/** A single workspace tile. The live one is a real button; staged ones are muted cards with a
 *  status badge. */
function WorkspaceCard({ ws, onSelect }: { ws: Workspace; onSelect: () => void }) {
  const Icon = ws.icon;
  const style = { ['--ws-accent' as string]: ws.accent } as React.CSSProperties;

  const inner = (
    <>
      {ws.status !== 'live' && <span className="oc-ws-card__badge">{STATUS_LABEL[ws.status]}</span>}
      <WorkspacePreview id={ws.id} />
      <div className="oc-ws-card__head">
        <div className="oc-ws-card__icon">
          <Icon size={20} />
        </div>
        <div className="oc-ws-card__title">{ws.title}</div>
      </div>
      <div className="oc-ws-card__desc">{ws.desc}</div>
      {ws.status === 'live' && (
        <div className="oc-ws-card__cta">
          Open <ArrowRight size={15} />
        </div>
      )}
    </>
  );

  if (ws.status === 'live') {
    // `oc-borderglow` goes on the button itself rather than a wrapper: wrapping would put a div
    // between the card and its own :hover/:focus-visible state, and the ring is meant to track
    // exactly those. Only live cards get it — a moving highlight on a "Coming soon" tile would
    // advertise something that does not open.
    return (
      <CardButton className="oc-ws-card oc-ws-card--live oc-borderglow" style={style} onClick={onSelect}>
        {inner}
      </CardButton>
    );
  }

  return (
    <div
      className={`oc-ws-card oc-ws-card--${ws.status}`}
      style={style}
      aria-disabled="true"
    >
      {inner}
    </div>
  );
}

/** Miniature, purely decorative illustrations built from divs so they follow theme and accent. */
function WorkspacePreview({ id }: { id: string }) {
  if (id === 'video') {
    return (
      <div className="oc-ws-prev oc-ws-prev--video" aria-hidden="true">
        <div className="oc-ws-prev__monitor" />
        <div className="oc-ws-prev__tracks">
          <i style={{ left: '4%', width: '34%' }} />
          <i style={{ left: '40%', width: '22%' }} />
          <i style={{ left: '64%', width: '30%' }} />
          <i className="oc-ws-prev__aud" style={{ left: '4%', width: '90%' }} />
          <b className="oc-ws-prev__playhead" />
        </div>
      </div>
    );
  }
  if (id === 'photo') {
    return (
      <div className="oc-ws-prev oc-ws-prev--photo" aria-hidden="true">
        <div className="oc-ws-prev__canvas">
          <span className="oc-ws-prev__sun" />
          <span className="oc-ws-prev__hill" />
          <span className="oc-ws-prev__text" />
        </div>
        <div className="oc-ws-prev__layers">
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  }
  return (
    <div className="oc-ws-prev oc-ws-prev--ai" aria-hidden="true">
      <Sparkles size={34} />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: typeof Clock;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="oc-home__section">
      <div className="oc-home__section-head">
        <Icon size={16} />
        <h2>{title}</h2>
        {action && <span className="oc-home__section-action">{action}</span>}
      </div>
      {children}
    </section>
  );
}
