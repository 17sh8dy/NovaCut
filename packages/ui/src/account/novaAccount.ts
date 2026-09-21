/**
 * Nova Cut's Nova Account: one client, and a hook to render it with.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE IS BUILT AROUND: NOVA CUT WORKS WITHOUT AN ACCOUNT, AND ALWAYS WILL.
 *
 * Nothing in the editor may consult this. No feature is gated on it, no dialog demands it, and an
 * installation that never signs in is not a degraded one; it is the normal one. What an account
 * adds is identity across the Nova ecosystem: the same account as Nova.Help and every other Nova
 * product.
 *
 * If you are here to make a feature require sign-in, the answer is no. Extend what an account
 * ADDS instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * NO PASSWORD BOX. EVER.
 *
 * Nova Cut never sees a Nova password. Signing in opens the person's browser with this app's
 * request, they sign in to Nova there, choose Connect, and type the code Nova Cut is showing to
 * finish; Nova Cut then receives a scoped token. That is the device authorization grant, chosen
 * precisely so a desktop app does not have to be trusted with a credential.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ONE FLOW AT A TIME. A second sign-in started while one is waiting would mint a second code, and
 * a code typed from the older one is the classic "that code did not work". Starting is refused
 * while one is in flight, and Cancel really stops it.
 *
 * `@nova/account-client` is the same module Replay.gg, Atlas and Online Earth use, so the
 * offline-is-not-a-sign-out logic lives in one place. It has no dependencies and no opinion about
 * where a token is stored, which is the one thing this file supplies.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createNovaAccountClient, type NovaAccount } from '@nova/account-client';
import { browserStorage } from '@nova/account-client/storage';

/**
 * Where Nova Accounts lives: Nova.Help on Cloudflare's free workers.dev address. The only place
 * this address appears in the UI package; the desktop shell's CSP allows exactly this host.
 *
 * Overridable at runtime by setting `window.__NOVA_ACCOUNTS_ORIGIN__` before the app boots, so a
 * development build can point at a local Nova.Help. (A global rather than `import.meta.env`,
 * because this package is bundler-agnostic. A dev override also needs the CSP widened to match.)
 */
const ORIGIN =
  (globalThis as { __NOVA_ACCOUNTS_ORIGIN__?: string }).__NOVA_ACCOUNTS_ORIGIN__ ??
  'https://nova-help.17sh8dy.workers.dev';

/**
 * `localStorage`, not a file in userData: the renderer's storage survives restarts, it needs no
 * preload method or IPC channel, and the token is scoped and revocable either way.
 *
 * The product id is the one Nova Accounts has on record for this app.
 */
export const novaAccount = createNovaAccountClient({
  product: 'open-cut',
  /* `support` so a ticket can be filed as you. Neither scope is granted by asking: Nova Accounts
     intersects this with what this product is registered for. */
  scopes: ['support', 'sync'],
  origin: ORIGIN,
  storage: browserStorage('opencut.nova.account'),
});

/** Nova Cut's section of the support portal. A real page today. */
export const NOVA_HELP_URL = `${ORIGIN}/help/nova-cut`;

export type SignInState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; userCode: string; verificationUri: string; verificationUriComplete: string }
  | { phase: 'failed'; message: string };

/**
 * Everything a pane needs, and nothing that runs on its own.
 *
 * It makes no network call on mount: an app that pings an identity server every time a settings
 * window opens talks to the network for somebody who never asked it to. Startup does one check,
 * and only when a token is held (`useNovaStartupCheck`).
 */
export function useNovaAccount() {
  const [account, setAccount] = useState<NovaAccount | null>(() => novaAccount.account());
  const [signIn, setSignIn] = useState<SignInState>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);
  const flowRef = useRef<{ cancel(): void } | null>(null);

  const begin = useCallback(async (deviceName: string | null, openExternal?: (url: string) => void) => {
    if (flowRef.current) return; // one flow at a time
    setSignIn({ phase: 'starting' });
    const flow = await novaAccount.beginSignIn({ deviceName });

    if (!flow.ok) {
      setSignIn({
        phase: 'failed',
        message:
          flow.reason === 'unavailable'
            ? 'Could not reach Nova Accounts. Check your connection and try again.'
            : 'Nova Accounts refused this app. That is a bug; please report it.',
      });
      return;
    }

    flowRef.current = flow;
    setSignIn({
      phase: 'waiting',
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      verificationUriComplete: flow.verificationUriComplete,
    });
    /* Opening the browser is a convenience, never the mechanism: the code is on screen and works
       if this does nothing, which is what a host with no `openExternal` gets. */
    openExternal?.(flow.verificationUriComplete);

    const result = await flow.wait();
    flowRef.current = null;
    if (result.ok) {
      setAccount(result.account);
      setSignIn({ phase: 'idle' });
      return;
    }
    // Cancel already put the pane back to idle; that is not a failure to report.
    if (result.reason === 'cancelled') {
      setSignIn({ phase: 'idle' });
      return;
    }
    setSignIn({
      phase: 'failed',
      message:
        result.reason === 'denied'
          ? 'The request was refused in the browser.'
          : 'That code expired before it was approved. Try again.',
    });
  }, []);

  /** Stop waiting. Nothing was stored, so there is nothing to undo. */
  const dismiss = useCallback(() => {
    flowRef.current?.cancel();
    flowRef.current = null;
    setSignIn({ phase: 'idle' });
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    await novaAccount.signOut();
    setAccount(null);
    setSignIn({ phase: 'idle' });
    setBusy(false);
  }, []);

  return { account, signedIn: account !== null, signIn, busy, begin, signOut, dismiss, setAccount };
}

/**
 * Check a stored token once, at startup, and only if there is one.
 *
 * A network failure MUST NOT sign somebody out: the client already refuses to drop a token on a
 * failed request, and this exists so nothing in the UI decides to be helpful about it later.
 */
export function useNovaStartupCheck() {
  useEffect(() => {
    if (!novaAccount.isSignedIn()) return;
    void novaAccount.refresh();
  }, []);
}
