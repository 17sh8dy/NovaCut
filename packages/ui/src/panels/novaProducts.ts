/**
 * The Nova products, as shown in the product switcher, its "View all" grid and the Account pane,
 * and the one function that opens them.
 *
 * Opening one is a different act depending on what it is:
 *   - 'app'  : a desktop app. The desktop shell launches it in the background (or brings it forward
 *              if it is already running); if it is not installed the person is sent to where they
 *              can get it. Addresses and program names live in the shell (electron/products.ts),
 *              keyed by `id`, so this list is only what gets shown.
 *   - 'site' : a website, opened in the default browser.
 *   - 'soon' : nothing to open yet; rendered disabled rather than as a link to somewhere guessed.
 *
 * KEEP IN SYNC BY HAND with Replay.gg's and Atlas's switchers (same ids, same kinds). Only sites
 * that are deployed and have a real address are links; the rest are "Soon" until they are.
 */

import type { LucideIcon } from 'lucide-react';
import { FileText, Gamepad2, Globe, LifeBuoy, Scissors, Sparkles } from 'lucide-react';
import type { OpenProductResult, PlatformBridge } from '@opencut/core';

export type NovaProductKind = 'app' | 'site' | 'soon';

export interface NovaProduct {
  id: string;
  label: string;
  tagline: string;
  icon: LucideIcon;
  kind: NovaProductKind;
}

export const NOVA_APPS: NovaProduct[] = [
  { id: 'nova-cut', label: 'Nova Cut', tagline: 'Create and edit', icon: Scissors, kind: 'app' },
  { id: 'replay-gg', label: 'Replay.GG', tagline: 'Record and clip gameplay', icon: Gamepad2, kind: 'app' },
  { id: 'atlas', label: 'Atlas', tagline: 'Your desktop assistant', icon: Sparkles, kind: 'app' },
  { id: 'nova-games', label: 'Nova Games', tagline: 'Coming soon', icon: Gamepad2, kind: 'soon' },
];

export const NOVA_SITES: NovaProduct[] = [
  { id: 'nova-help', label: 'Nova.Help', tagline: 'Support and guides', icon: LifeBuoy, kind: 'site' },
  { id: 'atlas-site', label: 'Atlas Website', tagline: 'Download and learn about Atlas', icon: Sparkles, kind: 'site' },
  { id: 'nova', label: 'Nova', tagline: 'The Nova home page', icon: Globe, kind: 'site' },
  { id: 'nova-legal', label: 'Nova Legal', tagline: 'Terms and privacy', icon: FileText, kind: 'soon' },
  { id: 'nova-cut-site', label: 'Nova Cut Website', tagline: 'Nova Cut, on the web', icon: Scissors, kind: 'soon' },
];

/** The Nova home page, and where a Nova Account is managed. Real, deployed addresses. */
export const NOVA_HOME_URL = 'https://nova-780.pages.dev/';
export const NOVA_ACCOUNT_URL = 'https://nova-780.pages.dev/account';

type Notify = (title: string, kind?: 'info' | 'success' | 'error', body?: string) => void;

/**
 * Open a product, and tell the person when something other than "it just opened" happened.
 * Never throws: a launcher that raises an error to a menu click is worse than one that says so.
 */
export async function openNovaProduct(
  bridge: PlatformBridge,
  notify: Notify,
  product: Pick<NovaProduct, 'id' | 'label'>,
): Promise<OpenProductResult | 'unavailable'> {
  if (!bridge.openProduct) {
    notify(`Can't open ${product.label} here`, 'info', 'Opening other Nova products needs the desktop app.');
    return 'unavailable';
  }
  let result: OpenProductResult;
  try {
    result = await bridge.openProduct(product.id);
  } catch {
    notify(`Couldn't open ${product.label}`, 'error');
    return 'unknown';
  }
  switch (result) {
    case 'launched':
      notify(`Opening ${product.label}…`, 'info');
      break;
    case 'running':
      notify(`${product.label} is already running`, 'info', 'Open it from the system tray.');
      break;
    case 'not-installed':
      notify(`${product.label} isn't installed on this PC`, 'info', 'Opening where you can get it.');
      break;
    case 'unknown':
      notify(`Couldn't open ${product.label}`, 'error');
      break;
    default:
      break; // 'focused' and 'site': it is in front of the person already, nothing to explain
  }
  return result;
}
