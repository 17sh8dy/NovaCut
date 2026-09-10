import { useEffect } from 'react';
import { Copy, Scissors, Trash2, EyeOff, ChevronsLeftRight } from 'lucide-react';
import {
  deleteClip,
  duplicateClip,
  rippleDeleteClip,
  splitClip,
  updateClip,
  type Clip,
} from '@opencut/core';
import { useAppStore, useStore } from '../state/context.js';
import { formatCombo } from '../state/shortcuts.js';

interface Props {
  x: number;
  y: number;
  clip: Clip;
  onClose: () => void;
}

/** Right-click menu for a timeline clip. Positions itself, closes on outside click/Esc. */
export function ClipContextMenu({ x, y, clip, onClose }: Props) {
  const store = useAppStore();
  const playhead = useStore((s) => s.playhead);
  // Read live, not hard-coded, so a rebind in Settings > Keyboard shows up here too.
  const shortcuts = useStore((s) => s.shortcuts);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onClose();
  };

  const seq = store.getState().sequence();
  const item = (label: string, icon: React.ReactNode, onClick: () => void, shortcut?: string, danger?: boolean) => (
    <div className="oc-ctx__item" data-danger={danger} onClick={run(onClick)}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon}
        {label}
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </div>
  );

  return (
    <div className="oc-ctx glass" style={{ left: Math.min(x, window.innerWidth - 210), top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {item('Split at Playhead', <Scissors size={15} />, () => store.getState().dispatch(splitClip(clip.id, playhead)), formatCombo(shortcuts.split))}
      {item('Duplicate', <Copy size={15} />, () => store.getState().dispatch(duplicateClip(clip.id)), formatCombo(shortcuts.duplicate))}
      {item(
        clip.enabled ? 'Disable' : 'Enable',
        <EyeOff size={15} />,
        () => store.getState().dispatch({ label: 'Toggle Clip', apply: (p) => updateClip(p, seq.id, clip.id, (c) => ({ ...c, enabled: !c.enabled })) }),
      )}
      <div className="oc-ctx__sep" />
      {item('Ripple Delete', <ChevronsLeftRight size={15} />, () => store.getState().dispatch(rippleDeleteClip(clip.id)), formatCombo(shortcuts.rippleDelete))}
      {item('Delete', <Trash2 size={15} />, () => store.getState().dispatch(deleteClip(clip.id)), formatCombo(shortcuts.delete), true)}
    </div>
  );
}
