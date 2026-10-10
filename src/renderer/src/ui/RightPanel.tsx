import { useEffect, useRef, useState } from 'react';
import type { Profile, Project, RightPanelTab, Session } from '@shared/types';
import type { ProfileUsage } from '@shared/usage';
import { UsagePanel } from './usage';
import { TasksPanel } from './TasksPanel';
import { DiffPanel } from './DiffPanel';
import { FilesPanel } from './FilesPanel';
import { api } from '../api';
import { useT } from '../i18n';
import { pasteInto } from '../terminal/registry';
import { Button } from './Modal';

const TABS: RightPanelTab[] = ['notes', 'files', 'diff', 'tasks', 'usage'];

/** Collapsible right panel (§4): notes, files, git diff, tasks, usage. */
export function RightPanel(props: {
  tab: RightPanelTab;
  width: number;
  project: Project | null;
  activeSessionId: string | null;
  activeSession: Session | null;
  profiles: Profile[];
  usage: ProfileUsage[];
  onSelectSession(id: string): void;
  onTab(tab: RightPanelTab): void;
  onClose(): void;
  onResize(width: number): void;
}) {
  const t = useT();
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const initial = props.width;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      props.onResize(Math.min(640, Math.max(240, initial + start - ev.clientX)));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-panel"
      style={{ width: props.width }}
      aria-label={t('panel.label')}
      data-testid="right-panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('panel.resize')}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30"
        onPointerDown={startResize}
      />
      <div className="flex h-10 shrink-0 items-stretch border-b border-line" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={props.tab === tab}
            className={`px-3 text-xs ${
              props.tab === tab
                ? 'border-b-2 border-accent font-semibold text-fg'
                : 'text-muted hover:text-fg'
            }`}
            onClick={() => props.onTab(tab)}
            data-testid={`panel-tab-${tab}`}
          >
            {t(`panel.${tab}`)}
          </button>
        ))}
        <button
          className="ml-auto px-3 text-muted hover:text-fg"
          onClick={props.onClose}
          aria-label={t('panel.close')}
          title={t('panel.close')}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {props.tab === 'notes' ? (
          props.project ? (
            <Notes key={props.project.id} project={props.project} activeSessionId={props.activeSessionId} />
          ) : (
            <p className="text-muted">{t('notes.noProject')}</p>
          )
        ) : props.tab === 'files' ? (
          <FilesPanel session={props.activeSession} />
        ) : props.tab === 'usage' ? (
          <UsagePanel profiles={props.profiles} usage={props.usage} />
        ) : props.tab === 'tasks' ? (
          <TasksPanel
            project={props.project}
            profiles={props.profiles}
            onStarted={props.onSelectSession}
            onSelectSession={props.onSelectSession}
          />
        ) : (
          <DiffPanel session={props.activeSession} />
        )}
      </div>
    </aside>
  );
}

function Notes({ project, activeSessionId }: { project: Project; activeSessionId: string | null }) {
  const t = useT();
  const [body, setBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  const latest = useRef('');

  useEffect(() => {
    void api.invoke('notes:get', project.id).then((b) => {
      latest.current = b;
      setBody(b);
    });
    return () => {
      // Flush a pending save when switching projects or closing the panel.
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        void api.invoke('notes:set', project.id, latest.current);
      }
    };
  }, [project.id]);

  const onChange = (v: string) => {
    setBody(v);
    latest.current = v;
    setSaving(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void api.invoke('notes:set', project.id, v).then(() => setSaving(false));
    }, 500);
  };

  const paste = () => {
    const el = ref.current;
    if (!el || !activeSessionId) return;
    const selected = el.value.slice(el.selectionStart, el.selectionEnd);
    pasteInto(activeSessionId, selected || el.value);
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate">{t('notes.for', { name: project.name })}</span>
        <span aria-live="polite">{body === null ? '' : saving ? t('notes.saving') : t('notes.saved')}</span>
      </div>
      <textarea
        ref={ref}
        className="min-h-48 w-full flex-1 resize-none rounded border border-line bg-bg p-2 text-fg placeholder:text-muted focus:border-accent"
        value={body ?? ''}
        placeholder={t('notes.placeholder')}
        onChange={(e) => onChange(e.target.value)}
        disabled={body === null}
        aria-label={t('notes.for', { name: project.name })}
        data-testid="notes"
      />
      <Button onClick={paste} disabled={!activeSessionId || !body} title={t('notes.pasteHint')}>
        {t('notes.paste')}
      </Button>
    </div>
  );
}
