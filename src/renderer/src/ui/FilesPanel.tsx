import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileEntry, FilePreview, Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { pasteInto } from '../terminal/registry';
import { Button, inputCls } from './Modal';

type Children = { entries: FileEntry[]; more: number } | { error: string } | 'loading';

const formatSize = (n: number | null) =>
  n === null
    ? ''
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;

/**
 * Right panel "Files" (§5): the session's folder as a tree, a read-only preview, and
 * hand-offs — "@path" to claude, open with the OS, show in the file manager, copy the path.
 * Folders load when opened. Not an editor: changes are claude's (or the user's own tools').
 */
export function FilesPanel({ session }: { session: Session | null }) {
  const t = useT();
  const cwd = session && !session.sshHostId ? session.cwd : null;
  const [tree, setTree] = useState<Map<string, Children>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | { error: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    async (rel: string) => {
      if (!cwd) return;
      setTree((m) => new Map(m).set(rel, m.get(rel) ?? 'loading'));
      try {
        const r = await api.invoke('files:list', cwd, rel);
        setTree((m) => new Map(m).set(rel, r));
      } catch (e) {
        setTree((m) => new Map(m).set(rel, { error: errorKey(e) }));
      }
    },
    [cwd],
  );

  /** Reload the root and every open folder (claude may have added or removed files). */
  const refresh = useCallback(() => {
    void load('');
    for (const rel of open) void load(rel);
  }, [load, open]);

  useEffect(() => {
    setTree(new Map());
    setOpen(new Set());
    setSelected(null);
    setPreview(null);
    if (cwd) void load('');
  }, [cwd, load]);

  // A turn of this session ended: its files may have changed.
  useEffect(() => {
    if (!session) return;
    return api.on('activity:changed', (id, activity) => {
      if (id === session.id && (activity === 'done' || activity === 'waiting')) refresh();
    });
  }, [session, refresh]);

  useEffect(() => {
    if (!cwd || !selected) return;
    let alive = true;
    setPreview(null);
    void api.invoke('files:preview', cwd, selected).then(
      (p) => alive && setPreview(p),
      (e) => alive && setPreview({ error: errorKey(e) }),
    );
    return () => {
      alive = false;
    };
  }, [cwd, selected]);

  const toggle = (rel: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else {
        n.add(rel);
        if (!tree.has(rel)) void load(rel);
      }
      return n;
    });
  };

  const q = filter.trim().toLowerCase();
  /** With a filter: a loaded entry shows when it, or something loaded below it, matches. */
  const matches = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    const walk = (rel: string): boolean => {
      const c = tree.get(rel);
      if (!c || c === 'loading' || 'error' in c) return false;
      let any = false;
      for (const e of c.entries) {
        const below = e.kind === 'dir' && walk(e.path);
        if (below || e.name.toLowerCase().includes(q)) {
          keep.add(e.path);
          any = true;
        }
      }
      return any;
    };
    walk('');
    return keep;
  }, [q, tree]);

  if (!session) return <p className="text-muted">{t('files.noSession')}</p>;
  if (!cwd) return <p className="text-muted">{t('files.ssh')}</p>;

  const sep = cwd.includes('\\') ? '\\' : '/';
  const absPath = (rel: string) => `${cwd.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
  const flash = (key: string) => {
    setNote(key);
    window.setTimeout(() => setNote((n) => (n === key ? null : n)), 2000);
  };

  const rows = (rel: string, depth: number): React.ReactNode => {
    const c = tree.get(rel);
    if (!c || c === 'loading')
      return (
        <li className="text-xs text-muted" style={{ paddingLeft: depth * 12 + 20 }}>
          {t('files.loading')}
        </li>
      );
    if ('error' in c)
      return (
        <li className="text-xs text-danger" style={{ paddingLeft: depth * 12 + 20 }}>
          {t(c.error)}
        </li>
      );
    const list = matches ? c.entries.filter((e) => matches.has(e.path)) : c.entries;
    return (
      <>
        {list.map((e) => {
          const isOpen = e.kind === 'dir' && (open.has(e.path) || (!!matches && tree.has(e.path)));
          return (
            <li key={e.path}>
              <button
                className={`flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left text-xs hover:bg-panel-2 ${
                  selected === e.path ? 'bg-panel-2 font-medium' : ''
                }`}
                style={{ paddingLeft: depth * 12 + 4 }}
                onClick={() => (e.kind === 'dir' ? toggle(e.path) : setSelected(e.path))}
                onDoubleClick={() => e.kind === 'file' && void api.invoke('files:open', cwd, e.path)}
                title={e.path}
                aria-expanded={e.kind === 'dir' ? isOpen : undefined}
                data-testid="file-entry"
                data-path={e.path}
              >
                <span className="w-3 shrink-0 text-muted" aria-hidden>
                  {e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span aria-hidden>{e.kind === 'dir' ? '📁' : '📄'}</span>
                <span className="font-path min-w-0 flex-1 truncate">{e.name}</span>
                {e.kind === 'file' && (
                  <span className="shrink-0 text-[10px] text-muted">{formatSize(e.size)}</span>
                )}
              </button>
              {isOpen && <ul>{rows(e.path, depth + 1)}</ul>}
            </li>
          );
        })}
        {c.more > 0 && (
          <li className="text-xs text-muted" style={{ paddingLeft: depth * 12 + 20 }}>
            {t('files.more', { n: c.more })}
          </li>
        )}
        {!list.length && !c.more && (
          <li className="text-xs text-muted" style={{ paddingLeft: depth * 12 + 20 }}>
            {t(matches ? 'files.noMatch' : 'files.empty')}
          </li>
        )}
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="files-panel">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-path min-w-0 flex-1 truncate text-muted" title={cwd}>
          📁 {cwd}
        </span>
        <button
          className="text-muted hover:text-fg"
          onClick={refresh}
          aria-label={t('files.refresh')}
          title={t('files.refresh')}
          data-testid="files-refresh"
        >
          ↻
        </button>
      </div>
      <input
        className={`${inputCls} text-xs`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t('files.filter')}
        aria-label={t('files.filter')}
        data-testid="files-filter"
      />
      <ul className="min-h-24 flex-1 overflow-y-auto" role="tree" aria-label={t('panel.files')}>
        {rows('', 0)}
      </ul>

      {selected && (
        <div
          className="flex max-h-[55%] min-h-0 flex-col gap-1.5 border-t border-line pt-2"
          data-testid="file-preview"
        >
          <div className="font-path truncate text-xs font-medium" title={selected}>
            {selected}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              variant="primary"
              disabled={session.location !== 'embedded'}
              title={t('files.mentionHint')}
              onClick={() => {
                // claude's own file reference: "@path" (quoted when the path has spaces).
                const ref = /\s/.test(selected) ? `@"${selected}" ` : `@${selected} `;
                if (pasteInto(session.id, ref)) flash('files.mentioned');
              }}
              data-testid="file-mention"
            >
              💬 {t('files.mention')}
            </Button>
            <Button
              onClick={() =>
                void api.invoke('files:open', cwd, selected).catch(() => flash('files.error.open'))
              }
            >
              {t('files.open')}
            </Button>
            <Button onClick={() => void api.invoke('files:reveal', cwd, selected)}>
              {t('files.reveal')}
            </Button>
            <Button
              onClick={() => {
                api.send('clipboard:write', absPath(selected));
                flash('files.copied');
              }}
              data-testid="file-copy"
            >
              {t('files.copy')}
            </Button>
          </div>
          {note && (
            <p className="text-xs text-ok" role="status">
              {t(note)}
            </p>
          )}
          {preview === null ? (
            <p className="text-xs text-muted">{t('files.loading')}</p>
          ) : 'error' in preview ? (
            <p className="text-xs text-danger">{t(preview.error)}</p>
          ) : preview.kind === 'binary' ? (
            <p className="text-xs text-muted">{t('files.binary', { size: formatSize(preview.size) })}</p>
          ) : (
            <>
              <pre
                className="min-h-0 flex-1 overflow-auto whitespace-pre rounded bg-bg p-2 font-mono text-[11px] leading-snug"
                data-testid="file-preview-text"
              >
                {preview.text || ' '}
              </pre>
              {preview.truncated && (
                <p className="text-[11px] text-muted">
                  {t('files.truncated', { size: formatSize(preview.size) })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
