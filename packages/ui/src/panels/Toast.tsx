import { useEffect } from 'react';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useAppStore, useStore } from '../state/context.js';

/** Transient bottom-center notification, auto-dismissing after a few seconds. */
export function Toast() {
  const store = useAppStore();
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => store.setState({ toast: null }), 3200);
    return () => window.clearTimeout(id);
  }, [toast, store]);

  if (!toast) return null;
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? XCircle : Info;
  const color = toast.kind === 'success' ? 'var(--success)' : toast.kind === 'error' ? 'var(--danger)' : 'var(--info)';

  return (
    <div className={`oc-toast oc-toast--${toast.kind} glass`}>
      <Icon size={17} style={{ color }} />
      <div>
        <div style={{ fontWeight: 500 }}>{toast.title}</div>
        {toast.body && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{toast.body}</div>}
      </div>
    </div>
  );
}
