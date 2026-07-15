import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({ variant = 'default', size = 'md', icon, children, className = '', ...rest }: ButtonProps) {
  const cls = [
    'oc-btn',
    variant !== 'default' && `oc-btn--${variant}`,
    size !== 'md' && `oc-btn--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: 'sm' | 'md';
}

export function IconButton({ active, size = 'md', className = '', children, ...rest }: IconButtonProps) {
  const cls = ['oc-iconbtn', size === 'sm' && 'oc-iconbtn--sm', className].filter(Boolean).join(' ');
  return (
    <button className={cls} data-active={active ? 'true' : undefined} {...rest}>
      {children}
    </button>
  );
}
