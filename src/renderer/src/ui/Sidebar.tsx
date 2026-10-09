import { useState } from 'react';
import type { Profile, Project, PtyState, Session } from '@shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AuthStatusLabel, ProfileBadge, SessionStateLabel } from './badges';
import { ProfileSelect } from './dialogs';

interface Props {
  profiles: Profile[];
  projects: Project[];
  sessions: Session[];
  ptyStates: Record<string, PtyState>;
  activeId: string | null;
  onAddProfile(): void;
  onRemoveProfile(p: Profile): void;
  onAddProject(): void;
  onRemoveProject(p: Project): void;
  onNewSession(projectId: string | null): void;
  onSelectSession(id: string): void;
  onReopenSession(id: string): void;
}

function SectionHeader({
  title,
  action,
  onAction,
  testId,
}: {
  title: string;
  action: string;
  onAction(): void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <button
        className="rounded px-1.5 text-base leading-none text-muted hover:bg-panel-2 hover:text-fg"
        onClick={onAction}
        title={action}
        aria-label={action}
        data-testid={testId}
      >
        +
      </button>
    </div>
  );
}

export function Sidebar(props: Props) {
  const t = useT();
  const byId = new Map(props.profiles.map((p) => [p.id, p]));
  const [showHistory, setShowHistory] = useState<Record<string, boolean>>({});

  const sessionRow = (s: Session) => (
    <li key={s.id}>
      <button
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2 ${
          props.activeId === s.id ? 'bg-panel-2' : ''
        }`}
        onClick={() => props.onSelectSession(s.id)}
        aria-current={props.activeId === s.id}
      >
        <span
          className="h-3 w-1 shrink-0 rounded"
          style={{ background: byId.get(s.profileId)?.color }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        <SessionStateLabel session={s} state={props.ptyStates[s.id] ?? 'idle'} />
      </button>
    </li>
  );

  const historyRow = (s: Session) => (
    <li key={s.id} className="flex items-center gap-2 px-2 py-0.5 text-muted">
      <span
        className="h-3 w-1 shrink-0 rounded opacity-60"
        style={{ background: byId.get(s.profileId)?.color }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      <button className="text-xs text-accent hover:underline" onClick={() => props.onReopenSession(s.id)}>
        {t('sidebar.reopen')}
      </button>
      <button
        className="text-xs hover:text-danger"
        onClick={() => void api.invoke('sessions:remove', s.id)}
        aria-label={t('session.remove')}
        title={t('session.remove')}
      >
        ✕
      </button>
    </li>
  );

  const group = (key: string, sessions: Session[]) => {
    const open = sessions.filter((s) => s.open);
    const closed = sessions.filter((s) => !s.open);
    return (
      <>
        <ul className="space-y-0.5">{open.map(sessionRow)}</ul>
        {closed.length > 0 && (
          <div className="mt-1">
            <button
              className="px-2 text-[11px] text-muted hover:text-fg"
              onClick={() => setShowHistory((h) => ({ ...h, [key]: !h[key] }))}
              aria-expanded={!!showHistory[key]}
            >
              {showHistory[key] ? '▾' : '▸'} {t('sidebar.history')} ({closed.length})
            </button>
            {showHistory[key] && <ul>{closed.slice().reverse().map(historyRow)}</ul>}
          </div>
        )}
      </>
    );
  };

  const loose = props.sessions.filter((s) => !s.projectId);

  return (
    <nav
      className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel"
      aria-label="sidebar"
    >
      <SectionHeader
        title={t('sidebar.profiles')}
        action={t('sidebar.addProfile')}
        onAction={props.onAddProfile}
        testId="add-profile"
      />
      <ul className="space-y-1 px-2" data-testid="profile-list">
        {props.profiles.map((p) => (
          <li key={p.id} className="group rounded border border-transparent px-2 py-1.5 hover:border-line">
            <div className="flex items-center gap-2">
              <ProfileBadge profile={p} />
              <span className="text-xs text-muted">{t(`kind.${p.kind}`)}</span>
              <span className="ml-auto flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  className="rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-fg"
                  onClick={() => void api.invoke('profiles:checkAuth', p.id)}
                  title={t('auth.check')}
                  aria-label={t('auth.check')}
                >
                  ↻
                </button>
                <button
                  className="rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-danger"
                  onClick={() => props.onRemoveProfile(p)}
                  title={t('common.remove')}
                  aria-label={`${t('common.remove')} ${p.name}`}
                >
                  ✕
                </button>
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 pl-0.5">
              <AuthStatusLabel status={p.authStatus} />
              {p.accountEmail && <span className="truncate text-xs text-muted">{p.accountEmail}</span>}
            </div>
          </li>
        ))}
      </ul>

      <SectionHeader
        title={t('sidebar.projects')}
        action={t('sidebar.addProject')}
        onAction={props.onAddProject}
        testId="add-project"
      />
      {props.projects.length === 0 && <p className="px-4 text-xs text-muted">{t('sidebar.noProjects')}</p>}
      <ul className="space-y-2 px-2">
        {props.projects.map((pr) => (
          <li key={pr.id} className="rounded border border-line/60 bg-bg/40 p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={pr.path}>
                {pr.name}
              </span>
              <button
                className="rounded px-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                onClick={() => props.onNewSession(pr.id)}
                title={t('sidebar.newSessionIn')}
                aria-label={`${t('sidebar.newSessionIn')}: ${pr.name}`}
                data-testid={`new-session-${pr.name}`}
              >
                ＋
              </button>
              <button
                className="rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-danger"
                onClick={() => props.onRemoveProject(pr)}
                aria-label={`${t('common.remove')} ${pr.name}`}
                title={t('common.remove')}
              >
                ✕
              </button>
            </div>
            <div className="mt-1 text-xs">
              <span className="mb-0.5 block text-[11px] text-muted">📌 {t('sidebar.pinned')}</span>
              <ProfileSelect
                profiles={props.profiles}
                value={pr.pinnedProfileId ?? ''}
                allowNone
                onChange={(id) => void api.invoke('projects:update', pr.id, { pinnedProfileId: id || null })}
              />
            </div>
            <div className="mt-1">
              {group(
                pr.id,
                props.sessions.filter((s) => s.projectId === pr.id),
              )}
            </div>
          </li>
        ))}
      </ul>

      {loose.length > 0 && (
        <div className="px-2 pt-3">
          <h2 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t('sidebar.otherSessions')}
          </h2>
          {group('__loose', loose)}
        </div>
      )}
    </nav>
  );
}
