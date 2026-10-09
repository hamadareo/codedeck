import { useEffect, useRef, useState } from 'react';
import type { PtyState, Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { fitTerminal, getTerminal } from './registry';

interface Props {
  session: Session;
  active: boolean;
  ptyState: PtyState;
  exitCode: number | null;
}

/** Hosts one session's xterm. The PTY is started lazily when the tab is first shown. */
export function TerminalView({ session, active, ptyState, exitCode }: Props) {
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
    const ro = new ResizeObserver(() => fitTerminal(session.id));
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (host.parentElement === el) el.removeChild(host);
    };
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

  useEffect(() => {
    if (!active) return;
    fitTerminal(session.id);
    // Focus can be refused for a few frames (pane still hidden, a closing dialog restoring its own
    // focus), so retry until the terminal really has it: a new session must accept typing at once.
    let raf = 0;
    let tries = 0;
    const focus = () => {
      const { term, host } = getTerminal(session.id);
      term.focus();
      if (!host.contains(document.activeElement) && ++tries < 30) raf = requestAnimationFrame(focus);
    };
    raf = requestAnimationFrame(focus);
    if (session.location === 'embedded' && ptyState === 'idle') void start();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.location, ptyState, session.id]);

  const restart = () => {
    getTerminal(session.id).term.write('\r\n\x1b[2m────────\x1b[0m\r\n');
    void start();
  };

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ visibility: active ? 'visible' : 'hidden', zIndex: active ? 1 : 0 }}
      aria-hidden={!active}
    >
      {error && (
        <div role="alert" className="border-b border-line bg-danger/15 px-3 py-2 text-danger">
          {t('session.startFailed', { msg: t(error) })}
        </div>
      )}
      {ptyState === 'exited' && (
        <div className="flex items-center gap-3 border-b border-line bg-panel-2 px-3 py-1.5 text-muted">
          <span aria-hidden>■</span>
          <span>{t('session.exited', { code: exitCode ?? '-' })}</span>
          <button className="rounded border border-line px-2 py-0.5 text-fg hover:bg-panel" onClick={restart}>
            {t('session.restart')}
          </button>
        </div>
      )}
      <div ref={ref} className="min-h-0 flex-1" data-testid={`terminal-${session.id}`} />
    </div>
  );
}
