import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button.js';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
}

/** Accessible-ish centered modal with backdrop, Esc-to-close, and a footer slot. */
export function Modal({ title, onClose, children, footer, maxWidth }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="oc-backdrop" onPointerDown={onClose}>
      <div className="oc-modal" style={maxWidth ? { maxWidth } : undefined} onPointerDown={(e) => e.stopPropagation()}>
        <div className="oc-modal__header">
          <span className="oc-modal__title">{title}</span>
          <IconButton onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="oc-modal__body">{children}</div>
        {footer && <div className="oc-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
