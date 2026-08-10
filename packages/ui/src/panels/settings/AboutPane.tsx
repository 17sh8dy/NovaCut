/**
 * About.
 *
 * Deliberately short on links: a GitHub / website / Discord row is trivial to add and actively
 * harmful while those destinations don't exist, because a dead link in an About box is the first
 * thing that makes an app feel abandoned. They go in when there is somewhere to point them.
 */

import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../../components/primitives/index.js';
import { useAppStore } from '../../state/context.js';
import type { SystemInfo } from '@opencut/core';

const HIGHLIGHTS = [
  'Multi-track timeline with real transitions and GPU effects',
  'Photo workspace with layers, masks, selections and a paint engine',
  'WebGL2 compositor · Web Audio engine · FFmpeg export',
];

export function AboutPane() {
  const store = useAppStore();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void store.getState().bridge.systemInfo?.().then((i) => alive && setInfo(i ?? null));
    return () => { alive = false; };
  }, [store]);

  const lines: [string, string][] = [
    ['Version', info?.appVersion ?? '0.1.0'],
    ['Platform', info?.platform ?? 'desktop'],
    ['Electron', info?.electron ?? '—'],
    ['Chromium', info?.chrome ?? '—'],
    ['Node', info?.node ?? '—'],
    ['FFmpeg', info?.ffmpeg ?? 'Not detected'],
  ];

  return (
    <div className="oc-about">
      <div className="oc-about__mark" />
      <h1>Open Cut</h1>
      <p className="oc-about__tag">A professional non-linear video and photo editor.</p>

      <ul className="oc-about__highlights">
        {HIGHLIGHTS.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>

      <div className="oc-about__table">
        {lines.map(([k, v]) => (
          <div key={k} className="oc-about__line">
            <span>{k}</span>
            <span title={v}>{v}</span>
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
        onClick={async () => {
          // The one thing anyone ever wants from an About box: these numbers, as text, to paste
          // into a bug report.
          await navigator.clipboard.writeText(lines.map(([k, v]) => `${k}: ${v}`).join('\n')).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? 'Copied' : 'Copy version info'}
      </Button>

      <p className="oc-about__legal">
        MIT licensed. Built with Electron, React and FFmpeg — see each project for its own licence.
      </p>
    </div>
  );
}
