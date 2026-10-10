import { useEffect, useMemo, useRef, useState } from 'react';
import { filterPalette, type PaletteItem } from '@shared/palette';
import { useT } from '../i18n';

export interface PaletteEntry extends PaletteItem {
  run(): void;
  /** Right-aligned hint (shortcut, status). */
  hint?: string;
  color?: string;
}

/** Command palette (§4): jump to sessions, projects, profiles, settings, or run a command. */
export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose(): void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return filterPalette(entries, query).map((i) => byId.get(i.id)!);
  }, [entries, query]);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
  }, []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const close = (restore: boolean) => {
    onClose();
    if (restore) prevFocus.current?.focus();
  };
  const run = (e: PaletteEntry | undefined) => {
    if (!e) return;
    close(false);
    e.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(results[index]);
    }
  };

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[12vh]"
      onMouseDown={() => close(true)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="flex max-h-[70vh] w-[620px] max-w-[94vw] flex-col self-start overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="command-palette"
      >
        <input
          ref={inputRef}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-base text-fg outline-none placeholder:text-muted"
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `palette-${index}` : undefined}
          data-testid="palette-input"
        />
        <ul ref={listRef} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-3 text-muted">{t('palette.empty')}</li>}
          {results.map((r, i) => {
            const header = !query && r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <li key={r.id} role="presentation">
                {header && (
                  <div className="px-4 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {t(`palette.group.${header}`)}
                  </div>
                )}
                <div
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  className={`mx-1 flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 ${
                    i === index ? 'bg-accent text-on-accent' : 'hover:bg-panel-2'
                  }`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(r)}
                  data-testid="palette-item"
                >
                  {r.color && (
                    <span
                      className="h-3 w-1.5 shrink-0 rounded"
                      style={{ background: r.color }}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.detail && (
                    <span className={`truncate text-xs ${i === index ? '' : 'text-muted'}`}>{r.detail}</span>
                  )}
                  {r.hint && (
                    <span className={`shrink-0 text-xs ${i === index ? '' : 'text-muted'}`}>{r.hint}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-4 py-1.5 text-xs text-muted">{t('palette.hint')}</div>
      </div>
    </div>
  );
}
