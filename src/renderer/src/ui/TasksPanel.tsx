import { useCallback, useEffect, useState } from 'react';
import type { Profile, Project, Task, TaskStatus } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { Button, inputCls } from './Modal';
import { ProfileSelect } from './dialogs';

const STATUS_ICON: Record<TaskStatus, string> = { todo: '○', doing: '◐', done: '✓' };
const NEXT: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', done: 'todo' };

/** Right panel "Tasks" (§5 タスクバックログ): per-project list; start a task in a new session. */
export function TasksPanel(props: {
  project: Project | null;
  profiles: Profile[];
  onStarted(sessionId: string): void;
  onSelectSession(sessionId: string): void;
}) {
  const t = useT();
  const { project } = props;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (project) setTasks(await api.invoke('tasks:list', project.id));
  }, [project]);
  useEffect(() => {
    void load();
    setProfileId(project?.pinnedProfileId ?? props.profiles[0]?.id ?? '');
    return api.on('state:changed', (what) => what === 'tasks' && void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, project?.id]);

  if (!project) return <p className="text-muted">{t('tasks.noProject')}</p>;

  const add = async () => {
    if (!title.trim()) return;
    try {
      await api.invoke('tasks:create', project.id, title, body);
      setTitle('');
      setBody('');
      setError(null);
    } catch (e) {
      setError(errorKey(e));
    }
  };

  const start = async (task: Task) => {
    setStarting(task.id);
    setError(null);
    try {
      const s = await api.invoke('tasks:start', task.id, profileId || null);
      props.onStarted(s.id);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setStarting(null);
    }
  };

  const open = tasks.filter((x) => x.status !== 'done');
  const done = tasks.filter((x) => x.status === 'done');
  const row = (task: Task, i: number, list: Task[]) => (
    <li key={task.id} className="rounded border border-line bg-bg/40 p-2" data-testid="task">
      {editing === task.id ? (
        <TaskEditor task={task} onClose={() => setEditing(null)} />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <button
              className={`mt-0.5 shrink-0 ${task.status === 'done' ? 'text-ok' : task.status === 'doing' ? 'text-accent' : 'text-muted'}`}
              onClick={() => void api.invoke('tasks:update', task.id, { status: NEXT[task.status] })}
              title={t(`tasks.status.${task.status}`)}
              aria-label={`${t(`tasks.status.${task.status}`)}: ${task.title}`}
            >
              {STATUS_ICON[task.status]}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`break-words ${task.status === 'done' ? 'text-muted line-through' : ''}`}>
                {task.title}
              </div>
              {task.body && (
                <div className="line-clamp-2 whitespace-pre-wrap text-xs text-muted">{task.body}</div>
              )}
              <div className="text-[11px] text-muted">{t(`tasks.status.${task.status}`)}</div>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
            {task.status !== 'done' &&
              (task.sessionId ? (
                <button
                  className="text-accent hover:underline"
                  onClick={() => props.onSelectSession(task.sessionId!)}
                >
                  {t('tasks.openSession')}
                </button>
              ) : (
                <Button
                  variant="primary"
                  className="!px-2 !py-0.5 text-xs"
                  disabled={starting !== null}
                  onClick={() => void start(task)}
                  data-testid="task-start"
                >
                  ▶ {starting === task.id ? t('tasks.starting') : t('tasks.start')}
                </Button>
              ))}
            <span className="ml-auto flex gap-1 text-muted">
              <button
                className="hover:text-fg disabled:opacity-30"
                disabled={i === 0}
                onClick={() => void api.invoke('tasks:move', task.id, -1)}
                aria-label={t('tasks.up')}
                title={t('tasks.up')}
              >
                ↑
              </button>
              <button
                className="hover:text-fg disabled:opacity-30"
                disabled={i === list.length - 1}
                onClick={() => void api.invoke('tasks:move', task.id, 1)}
                aria-label={t('tasks.down')}
                title={t('tasks.down')}
              >
                ↓
              </button>
              <button
                className="hover:text-fg"
                onClick={() => setEditing(task.id)}
                aria-label={t('common.edit')}
                title={t('common.edit')}
              >
                ✎
              </button>
              <button
                className="hover:text-danger"
                onClick={() => void api.invoke('tasks:remove', task.id)}
                aria-label={t('common.remove')}
                title={t('common.remove')}
              >
                ✕
              </button>
            </span>
          </div>
        </>
      )}
    </li>
  );

  return (
    <div className="space-y-3" data-testid="tasks-panel">
      <div className="text-xs text-muted">{t('tasks.for', { name: project.name })}</div>
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className={inputCls}
          value={title}
          placeholder={t('tasks.titlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="task-title"
        />
        <textarea
          className={`${inputCls} min-h-14 resize-y`}
          value={body}
          placeholder={t('tasks.bodyPlaceholder')}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button type="submit" disabled={!title.trim()} data-testid="task-add">
          ＋ {t('tasks.add')}
        </Button>
      </form>
      <label className="block text-xs text-muted">
        {t('tasks.profile')}
        <ProfileSelect
          profiles={props.profiles}
          value={profileId}
          onChange={setProfileId}
          pinnedId={project.pinnedProfileId}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {t(error)}
        </p>
      )}
      {open.length === 0 && <p className="text-xs text-muted">{t('tasks.empty')}</p>}
      <ul className="space-y-1.5">{open.map((x, i) => row(x, i, open))}</ul>
      {done.length > 0 && (
        <div>
          <button
            className="text-xs text-muted hover:text-fg"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
          >
            {showDone ? '▾' : '▸'} {t('tasks.done', { n: done.length })}
          </button>
          {showDone && <ul className="mt-1 space-y-1.5">{done.map((x, i) => row(x, i, done))}</ul>}
        </div>
      )}
    </div>
  );
}

function TaskEditor({ task, onClose }: { task: Task; onClose(): void }) {
  const t = useT();
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  return (
    <form
      className="space-y-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await api.invoke('tasks:update', task.id, { title, body });
        onClose();
      }}
    >
      <input
        className={inputCls}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label={t('tasks.titlePlaceholder')}
      />
      <textarea
        className={`${inputCls} min-h-16 resize-y`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label={t('tasks.bodyPlaceholder')}
      />
      <div className="flex gap-1">
        <Button type="submit" variant="primary">
          {t('common.save')}
        </Button>
        <Button type="button" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
