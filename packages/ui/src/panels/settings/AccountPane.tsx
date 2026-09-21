/**
 * Settings > Nova Account.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FIRST THING THIS PANE SAYS IS THAT YOU DO NOT NEED IT.
 *
 * That sentence is at the top, in the same size as everything else, and it is the whole
 * difference between an optional layer and a gate. Nova Cut works signed out, every feature, for
 * good, and a settings pane is exactly the place that promise quietly stops being made.
 *
 * There is no password field, and there never will be one. Signing in opens your browser; you
 * choose Connect there and type the code shown here to finish. See account/novaAccount.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT CLAIMED HERE.
 *
 * Signing in WORKS, and the pane says so. Preference sync does NOT exist yet, and the pane says
 * that too in words, rather than showing a switch that persists and does nothing.
 *
 * VIEW HERE, EDIT ON NOVA: everything about the account is visible in this pane, but changing it
 * (name, email, password, picture) happens only on the Nova account page, which one button opens.
 */

import { useState } from 'react';
import { Check, Copy, ExternalLink, Globe, LogOut, RefreshCw, User } from 'lucide-react';
import { Button } from '../../components/primitives/index.js';
import { useAppStore } from '../../state/context.js';
import { NOVA_HELP_URL, useNovaAccount } from '../../account/novaAccount.js';
import {
  NOVA_ACCOUNT_URL,
  NOVA_APPS,
  NOVA_HOME_URL,
  NOVA_SITES,
  openNovaProduct,
  type NovaProduct,
} from '../novaProducts.js';

export function AccountPane() {
  const store = useAppStore();
  const { account, signedIn, signIn, busy, begin, signOut, dismiss } = useNovaAccount();
  const [copied, setCopied] = useState(false);

  /* Optional on the bridge, and absent on hosts with no browser to open. The code on screen is the
     mechanism; opening the browser is only ever the shortcut. */
  const openExternal = (url: string) => store.getState().bridge.openExternal?.(url);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied. The code is on screen and readable, which is the point of it being
      // eight characters rather than a token.
    }
  };

  // The other Nova products this account can be used in. Nova Cut itself is left out, and so is
  // Nova: it has its own section above, with the account links.
  const others = [...NOVA_APPS, ...NOVA_SITES].filter((p) => p.id !== 'nova-cut' && p.id !== 'nova');
  const launch = (p: NovaProduct) => {
    const { bridge, notify } = store.getState();
    void openNovaProduct(bridge, notify, p);
  };

  return (
    <div className="oc-account">
      <header className="oc-account__intro">
        <h1>Nova Account</h1>
        <p>
          <strong>Nova Cut does not need an account.</strong> Every feature works signed out, your
          projects stay on this machine, and nothing here changes that.
        </p>
        <p className="oc-account__muted">
          A Nova Account is one identity across Nova: the same account as Nova.Help and the other
          Nova products. Signing in adds things; it never takes anything away.
        </p>
      </header>

      {signedIn ? (
        <section className="oc-account__card">
          <div className="oc-account__who">
            <span className="oc-account__avatar" aria-hidden="true">
              <User size={18} />
            </span>
            <span>
              <strong>{account?.displayName ?? 'Signed in'}</strong>
              <span className="oc-account__muted">
                {account?.email ?? `Nova Account ${account?.id ?? ''}`}
              </span>
            </span>
          </div>

          <p className="oc-account__muted">
            Nova Cut can see who you are and file support tickets as you. It cannot see your
            password or your other Nova products’ data, and nothing on this machine has been
            uploaded.
          </p>

          <div className="oc-account__actions">
            <Button variant="ghost" onClick={() => void signOut()} disabled={busy}>
              <LogOut size={15} /> Sign out
            </Button>
            <Button onClick={() => openExternal(NOVA_ACCOUNT_URL)}>
              <ExternalLink size={15} /> Manage account
            </Button>
            <Button variant="ghost" onClick={() => openExternal(NOVA_HELP_URL)}>
              <ExternalLink size={15} /> Help with Nova Cut
            </Button>
          </div>

          <p className="oc-account__muted oc-account__fine">
            You can see your account here. To change your name, email, password or picture, use{' '}
            <button type="button" className="oc-account__link" onClick={() => openExternal(NOVA_ACCOUNT_URL)}>
              your Nova account page
            </button>
            .
          </p>
        </section>
      ) : signIn.phase === 'waiting' ? (
        <section className="oc-account__card">
          <p>
            <strong>Approve in your browser.</strong> It opened with Nova Cut’s request. Sign in to
            Nova, choose <strong>Connect</strong>, then type this code to finish. That last step makes
            sure it is this Nova Cut you are approving.
          </p>

          <div className="oc-account__code">
            <code>{signIn.userCode}</code>
            <Button variant="ghost" onClick={() => void copyCode(signIn.userCode)}>
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <p className="oc-account__muted">
            If the page did not open, go to{' '}
            <button
              type="button"
              className="oc-account__link"
              onClick={() => openExternal(signIn.verificationUri)}
            >
              {signIn.verificationUri}
            </button>{' '}
            and enter the code there. It expires in ten minutes.
          </p>

          <div className="oc-account__actions">
            <Button onClick={() => openExternal(signIn.verificationUriComplete)}>
              <RefreshCw size={15} /> Open the browser again
            </Button>
            <Button variant="ghost" onClick={dismiss}>
              Cancel
            </Button>
          </div>
        </section>
      ) : (
        <section className="oc-account__card">
          {signIn.phase === 'failed' && (
            <p className="oc-account__problem" role="alert">
              {signIn.message}
            </p>
          )}

          <p>Signing in connects this copy of Nova Cut to your Nova Account.</p>
          <ul className="oc-account__list">
            <li>The same account you use on Nova.Help and the other Nova apps; never a second one.</li>
            <li>Support tickets you file can be tied to your account, so you can follow them.</li>
          </ul>

          <div className="oc-account__actions">
            <Button onClick={() => void begin(hostName(), openExternal)} disabled={signIn.phase === 'starting'}>
              {signIn.phase === 'starting' ? 'Starting…' : 'Sign in to Nova'}
            </Button>
            <Button variant="ghost" onClick={() => openExternal(NOVA_HELP_URL)}>
              <ExternalLink size={15} /> Help with Nova Cut
            </Button>
          </div>

          <p className="oc-account__muted oc-account__fine">
            You will not be asked for a password here. Nova Cut opens your browser and shows a code;
            you approve it there, so this app never handles your Nova password.
          </p>
        </section>
      )}

      <section className="oc-account__card">
        <h2>Nova</h2>
        <p className="oc-account__muted">
          Your account lives on Nova. You can look around without signing in, and everything about
          your account is managed there.
        </p>
        <div className="oc-account__actions">
          <Button variant="ghost" onClick={() => openExternal(NOVA_HOME_URL)}>
            <Globe size={15} /> Nova
          </Button>
          <Button variant="ghost" onClick={() => openExternal(NOVA_ACCOUNT_URL)}>
            <ExternalLink size={15} /> Your account on Nova
          </Button>
          <Button variant="ghost" disabled title="The Nova Cut website isn't live yet">
            <Globe size={15} /> Nova Cut Website (coming soon)
          </Button>
        </div>
      </section>

      <section className="oc-account__card">
        <h2>Use your account in other Nova products</h2>
        <p className="oc-account__muted">
          One account works across Nova. Sign in once in each product. Apps open on this PC if you
          have them; if you don’t, you’ll be taken to where you can get them.
        </p>
        <div className="oc-account__products">
          {others.map((p) => {
            const Icon = p.icon;
            const soon = p.kind === 'soon';
            return (
              <button
                key={p.id}
                type="button"
                className="oc-account__product"
                disabled={soon}
                onClick={() => launch(p)}
              >
                <span className="oc-account__product-icon">
                  <Icon size={16} />
                </span>
                <span className="oc-account__product-text">
                  <strong>{p.label}</strong>
                  <span className="oc-account__muted">{p.tagline}</span>
                </span>
                <span className="oc-account__product-tag">
                  {soon ? 'Soon' : p.kind === 'site' ? 'Website' : 'App'}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="oc-account__card oc-account__card--quiet">
        <h2>Preference sync</h2>
        <p className="oc-account__muted">
          Not implemented yet. Nothing is uploaded, automatically or otherwise. When it lands it will
          be a button you press, and it will never overwrite what is on a machine without showing
          you both sides first.
        </p>
      </section>
    </div>
  );
}

/**
 * A name for this machine, so "signed in on" means something on the account page. Best effort and
 * never blocking; it is shown to its owner and to nobody else.
 */
function hostName(): string {
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return platform ? `Nova Cut on ${platform}` : 'Nova Cut';
}
