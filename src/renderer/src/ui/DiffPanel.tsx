import { useCallback, useEffect, useState } from 'react';
import type { GitStatus, Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { Button, ConfirmDialog, inputCls } from './Modal';

const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U', U: '!' };

/** Branch of a folder, refreshed every 15 s (pane headers, §5 ブランチ表示). */
export function useBranch(cwd: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd) return setBranch(null);
    let alive = true;
    const load = () =>
      void api.invoke('git:status', cwd).then(
        (s) => alive && setBranch(s.isRepo ? (s.branch ?? 'HEAD') : null),
        () => alive && setBranch(null),
      );
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cwd]);
  return branch;
}

/** Right panel "Diff" (§5 Git): changed files, per-file diff, review then commit. */
export function DiffPanel({ session }: { session: Session | null }) {
  const t = useT();
  const cwd = session?.cwd ?? null;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    try {
      setStatus(await api.invoke('git:status', cwd));
      setError(null);
    } catch (e) {
      setError(errorKey(e));
    }
  }, [cwd]);

  useEffect(() => {
    setFile(null);
    setDiff('');
    setResult(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!cwd || !file) return;
    void api.invoke('git:diff', cwd, file).then(setDiff, (e) => setDiff(String(e)));
  }, [cwd, file]);

  if (!session) return <p className="text-muted">{t('diff.noSession')}</p>;
  if (!status) return <p className="text-muted">…</p>;
  if (!status.isRepo) return <p className="text-muted">{t('diff.notRepo', { cwd: session.cwd })}</p>;

  const totals = status.files.reduce(
    (a, f) => ({ add: a.add + (f.added ?? 0), del: a.del + (f.deleted ?? 0) }),
    { add: 0, del: 0 },
  );

  return (
    <div className="space-y-3" data-testid="diff-panel">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-path rounded bg-panel-2 px-1.5 py-0.5" data-testid="diff-branch">
          ⎇ {status.branch ?? 'HEAD'}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-muted">
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <button
          className="ml-auto text-muted hover:text-fg"
          onClick={() => void load()}
          aria-label={t('diff.refresh')}
          title={t('diff.refresh')}
        >
          ↻
        </button>
      </div>
      {error && <p className="text-xs text-danger">{t(error)}</p>}
      {status.files.length === 0 ? (
        <p className="text-muted">{t('diff.clean')}</p>
      ) : (
        <>
          <div className="text-xs text-muted">
            {t('diff.summary', { files: status.files.length, add: totals.add, del: totals.del })}
          </div>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-testid="diff-files">
            {status.files.map((f) => (
              <li key={f.path}>
                <button
                  className={`flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-panel-2 ${file === f.path ? 'bg-panel-2' : ''}`}
                  onClick={() => setFile(f.path)}
                >
                  <span
                    className="w-3 shrink-0 font-mono text-muted"
                    title={t(`diff.status.${f.status === '?' ? 'untracked' : f.status}`)}
                  >
                    {STATUS_LABEL[f.status]}
                  </span>
                  <span className="font-path min-w-0 flex-1 truncate">{f.path}</span>
                  {f.added !== null && <span className="text-ok">+{f.added}</span>}
                  {f.deleted !== null && <span className="text-danger">-{f.deleted}</span>}
                </button>
              </li>
            ))}
          </ul>
          {file && <DiffView text={diff} />}
          <div className="space-y-1 border-t border-line pt-2">
            <label className="block text-xs text-muted" htmlFor="commit-message">
              {t('diff.message')}
            </label>
            <textarea
              id="commit-message"
              className={`${inputCls} min-h-16 resize-y font-mono text-xs`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="commit-message"
            />
            <div className="flex flex-wrap gap-1">
              <Button
                onClick={() =>
                  void api.invoke('git:askCommitMessage', session.id).catch((e) => setError(errorKey(e)))
                }
                disabled={session.location !== 'embedded'}
                title={t('diff.askHint')}
                data-testid="ask-commit-message"
              >
                ✨ {t('diff.ask')}
              </Button>
              <Button
                variant="primary"
                disabled={!message.trim()}
                onClick={() => setConfirm(true)}
                data-testid="commit"
              >
                {t('diff.commit')}
              </Button>
            </div>
            <p className="text-[11px] text-muted">{t('diff.askHint')}</p>
            {result && (
              <pre
                className={`max-h-32 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 text-[11px] ${result.ok ? 'text-ok' : 'text-danger'}`}
                data-testid="commit-result"
              >
                {result.output}
              </pre>
            )}
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('diff.confirmTitle')}
          body={t('diff.confirmBody', {
            files: status.files.length,
            branch: status.branch ?? 'HEAD',
            message: message.trim(),
          })}
          confirmLabel={t('diff.commit')}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            const r = await api.invoke('git:commit', session.cwd, message);
            setResult(r);
            if (r.ok) setMessage('');
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Unified diff with add/remove coloring (+ and - prefixes kept, so color is never the only cue). */
function DiffView({ text }: { text: string }) {
  return (
    <pre
      className="max-h-80 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[11px] leading-snug"
      data-testid="diff-view"
    >
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith('+') && !l.startsWith('+++')
              ? 'bg-ok/10 text-ok'
              : l.startsWith('-') && !l.startsWith('---')
                ? 'bg-danger/10 text-danger'
                : l.startsWith('@@')
                  ? 'text-accent'
                  : ''
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}
