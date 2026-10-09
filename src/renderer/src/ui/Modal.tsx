import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Props {
  title: string;
  children: ReactNode;
  onClose(): void;
  footer: ReactNode;
  width?: string;
}

/** Accessible modal: focus moves in, Esc closes, Tab stays inside. */
export function Modal({ title, children, onClose, footer, width = 'w-[480px]' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, button, textarea');
    first?.focus();
    const dialog = ref.current;
    return () => {
      // Restore focus only if nothing else took it (e.g. a terminal that just opened should keep it).
      const now = document.activeElement;
      if (!now || now === document.body || dialog?.contains(now)) prev?.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
    if (e.key === 'Tab' && ref.current) {
      const els = [
        ...ref.current.querySelectorAll<HTMLElement>('input, select, button, textarea, [tabindex="0"]'),
      ].filter((el) => !el.hasAttribute('disabled'));
      const first = els[0];
      const last = els[els.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${width} max-w-[92vw] rounded-lg border border-line bg-panel shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className="border-b border-line px-5 py-3 text-base font-semibold">{title}</h2>
        <div className="space-y-4 px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

export function Button({
  variant = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const cls = {
    primary: 'bg-accent text-black hover:brightness-110 font-medium',
    secondary: 'border border-line text-fg hover:bg-panel-2',
    danger: 'bg-danger text-black hover:brightness-110 font-medium',
  }[variant];
  return (
    <button
      {...props}
      className={`rounded px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50 ${cls} ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded border border-line bg-bg px-2 py-1.5 text-fg placeholder:text-muted/70 focus:border-accent';

export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useT();
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
          <Button variant={props.danger ? 'danger' : 'primary'} onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-wrap break-all leading-relaxed">{props.body}</p>
    </Modal>
  );
}
