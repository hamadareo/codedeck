import { useEffect, useRef, useState } from 'react';
import type { PtyState, Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { fileReferences } from '@shared/fileRef';
import { DND_FILE } from '../ui/FilesPanel';
import {
  clearFind,
  findInTerminal,
  fitTerminal,
  focusTerminal,
  getTerminal,
  nudgeRedraw,
  onFindRequest,
  onFindResults,
  pasteInto,
} from './registry';

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

  // Drop files (from the OS or the Files panel) onto the terminal: "@path" for claude, not sent.
  const [dropping, setDropping] = useState(false);
  const fileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DND_FILE);
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    if (!fileDrag(e) || session.sshHostId) return;
    e.preventDefault();
    e.stopPropagation();
    const fromPanel = e.dataTransfer.getData(DND_FILE);
    const paths = fromPanel
      ? [fromPanel]
      : [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) pasteInto(session.id, fileReferences(session.cwd, paths));
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!fileDrag(e) || session.sshHostId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Moving over the terminal's own elements is not leaving it (no flicker).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10 text-sm text-fg">
          {t('drop.hint')}
        </div>
      )}
      <FindBar sessionId={session.id} />
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

/**
 * Find in the terminal (⌘F / Ctrl+Shift+F): every match highlighted, Enter / Shift+Enter
 * (or ↓ / ↑) to move, Esc to close and go back to typing. Searches the scrollback too.
 */
function FindBar({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      onFindRequest((id) => {
        if (id !== sessionId) return;
        setOpen(true);
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.select();
        });
      }),
    [sessionId],
  );
  useEffect(() => (open ? onFindResults(sessionId, setResult) : undefined), [open, sessionId]);

  const find = (backwards: boolean, q = query, cs = caseSensitive, incremental = false) => {
    if (!q) {
      clearFind(sessionId);
      setResult(null);
      return;
    }
    findInTerminal(sessionId, q, backwards, cs, incremental);
  };
  const close = () => {
    setOpen(false);
    clearFind(sessionId);
    setResult(null);
    focusTerminal(sessionId);
  };
  if (!open) return null;

  const btn = 'rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg';
  const count = !query
    ? ''
    : result && result.resultCount > 0
      ? `${result.resultIndex >= 0 ? result.resultIndex + 1 : '?'} / ${result.resultCount}`
      : t('find.none');
  return (
    <div
      className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded border border-line bg-panel px-2 py-1 text-xs shadow-lg"
      role="search"
      data-testid="find-bar"
    >
      <input
        ref={input}
        className="w-44 rounded border border-line bg-bg px-1.5 py-0.5 text-fg focus:border-accent"
        value={query}
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        onChange={(e) => {
          setQuery(e.target.value);
          find(false, e.target.value, caseSensitive, true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            find(e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        data-testid="find-input"
      />
      <span
        className="min-w-14 text-center text-[11px] text-muted"
        aria-live="polite"
        data-testid="find-count"
      >
        {count}
      </span>
      <button className={btn} onClick={() => find(true)} title={t('find.prev')} aria-label={t('find.prev')}>
        ↑
      </button>
      <button className={btn} onClick={() => find(false)} title={t('find.next')} aria-label={t('find.next')}>
        ↓
      </button>
      <button
        className={`${btn} ${caseSensitive ? 'bg-panel-2 text-fg' : ''}`}
        onClick={() => {
          setCaseSensitive(!caseSensitive);
          find(false, query, !caseSensitive, true);
        }}
        title={t('find.case')}
        aria-label={t('find.case')}
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button className={btn} onClick={close} title={t('find.close')} aria-label={t('find.close')}>
        ✕
      </button>
    </div>
  );
}
