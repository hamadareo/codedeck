import { useEffect, useRef, useState } from 'react';
import type { PtyState, Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { fitTerminal, focusTerminal, getTerminal, nudgeRedraw } from './registry';

interface Props {
  session: Session;
  /** This pane has keyboard focus (the active session). */
  focused: boolean;
  ptyState: PtyState;
  exitCode: number | null;
}

/** Hosts one session's xterm inside a pane. The PTY is started lazily when first shown. */
export function TerminalView({ session, focused, ptyState, exitCode }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  // Attach the persistent xterm host into this container.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { host } = getTerminal(session.id);
    el.appendChild(host);
    fitTerminal(session.id);
    // Moved into a pane of another size, or attached in another window: let claude redraw.
    if (ptyState === 'running') nudgeRedraw(session.id);
    const ro = new ResizeObserver(() => fitTerminal(session.id));
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (host.parentElement === el) el.removeChild(host);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const start = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      fitTerminal(session.id);
      const { term } = getTerminal(session.id);
      await api.invoke('pty:start', session.id, term.cols, term.rows);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      startingRef.current = false;
    }
  };

  // Visible + embedded + not started → start claude.
  useEffect(() => {
    if (session.location === 'embedded' && ptyState === 'idle') void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.location, ptyState, session.id]);

  useEffect(() => {
    if (!focused) return;
    // Focus can be refused for a few frames (pane just mounted, a closing dialog restoring its own
    // focus), so retry until the terminal really has it: a new session must accept typing at once.
    let raf = 0;
    let tries = 0;
    const focus = () => {
      if (!focusTerminal(session.id) && ++tries < 30) raf = requestAnimationFrame(focus);
    };
    raf = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(raf);
  }, [focused, session.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div role="alert" className="border-b border-line bg-danger/15 px-3 py-2 text-danger">
          {t('session.startFailed', { msg: t(error) })}
        </div>
      )}
      {ptyState === 'exited' && (
        <div className="flex items-center gap-3 border-b border-line bg-panel-2 px-3 py-1.5 text-muted">
          <span aria-hidden>■</span>
          <span>{t('session.exited', { code: exitCode ?? '-' })}</span>
          <button
            className="rounded border border-line px-2 py-0.5 text-fg hover:bg-panel"
            onClick={() => void start()}
          >
            {t('session.restart')}
          </button>
        </div>
      )}
      <div ref={ref} className="min-h-0 flex-1" data-testid={`terminal-${session.id}`} />
    </div>
  );
}
