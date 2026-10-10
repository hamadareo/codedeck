import { useState } from 'react';
import type { Profile, Project, Session, SessionStatus } from '@shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AuthStatusLabel, ProfileBadge, SessionStatusLabel } from './badges';
import { ProfileSelect } from './dialogs';

interface Props {
  width: number;
  profiles: Profile[];
  projects: Project[];
  sessions: Session[];
  statusOf(id: string): SessionStatus;
  activeId: string | null;
  onAddProfile(): void;
  onEditProfile(p: Profile): void;
  onRemoveProfile(p: Profile): void;
  onAddProject(): void;
  onEditProject(p: Project): void;
  onRemoveProject(p: Project): void;
  onNewSession(projectId: string | null, profileId?: string): void;
  onSelectSession(id: string): void;
  onReopenSession(id: string): void;
  onRenameSession(s: Session): void;
}

const iconBtn = 'rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-fg';

function SectionHeader(props: { title: string; action: string; onAction(): void; testId: string }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{props.title}</h2>
      <button
        className="rounded px-1.5 text-base leading-none text-muted hover:bg-panel-2 hover:text-fg"
        onClick={props.onAction}
        title={props.action}
        aria-label={props.action}
        data-testid={props.testId}
      >
        +
      </button>
    </div>
  );
}

function Twisty({ open, onToggle, label }: { open: boolean; onToggle(): void; label: string }) {
  const t = useT();
  return (
    <button
      className="w-4 shrink-0 text-[10px] text-muted hover:text-fg"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? t('sidebar.collapse') : t('sidebar.expand')}: ${label}`}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

/** Left sidebar: profile → project → session (§4). Project management sits below the tree. */
export function Sidebar(props: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const profileById = new Map(props.profiles.map((p) => [p.id, p]));

  const sessionRow = (s: Session) => (
    <li key={s.id}>
      <button
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2 ${
          props.activeId === s.id ? 'bg-panel-2 font-medium' : ''
        }`}
        onClick={() => props.onSelectSession(s.id)}
        onDoubleClick={() => props.onRenameSession(s)}
        aria-current={props.activeId === s.id}
        data-testid="sidebar-session"
      >
        <span
          className="h-3 w-1 shrink-0 rounded"
          style={{ background: profileById.get(s.profileId)?.color }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        <SessionStatusLabel status={props.statusOf(s.id)} compact />
      </button>
    </li>
  );

  const historyRow = (s: Session) => (
    <li key={s.id} className="flex items-center gap-2 px-2 py-0.5 text-muted">
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      <button className="text-xs text-accent hover:underline" onClick={() => props.onReopenSession(s.id)}>
        {t('sidebar.reopen')}
      </button>
      <button
        className="text-xs hover:text-danger"
        onClick={() => void api.invoke('sessions:remove', s.id)}
        aria-label={`${t('session.remove')}: ${s.title}`}
        title={t('session.remove')}
      >
        ✕
      </button>
    </li>
  );

  const sessionList = (key: string, sessions: Session[]) => {
    const open = sessions.filter((s) => s.open);
    const closed = sessions.filter((s) => !s.open);
    return (
      <>
        {open.length > 0 && <ul className="space-y-0.5">{open.map(sessionRow)}</ul>}
        {open.length === 0 && closed.length === 0 && (
          <p className="px-2 py-0.5 text-xs text-muted">{t('sidebar.noSessions')}</p>
        )}
        {closed.length > 0 && (
          <div>
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

  const profileNode = (p: Profile) => {
    const mine = props.sessions.filter((s) => s.profileId === p.id);
    const projects = props.projects.filter(
      (pr) => pr.pinnedProfileId === p.id || mine.some((s) => s.projectId === pr.id),
    );
    const loose = mine.filter((s) => !s.projectId || !props.projects.some((pr) => pr.id === s.projectId));
    const key = `profile:${p.id}`;
    const open = !collapsed[key];
    return (
      <li key={p.id} className="rounded" data-testid="profile-node">
        <div className="group flex items-center gap-1.5 rounded px-1 py-1 hover:bg-panel-2/60">
          <Twisty open={open} onToggle={() => toggle(key)} label={p.name} />
          <ProfileBadge profile={p} />
          <span className="text-xs text-muted">{t(`kind.${p.kind}`)}</span>
          <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <button
              className={iconBtn}
              onClick={() => props.onEditProfile(p)}
              title={t('common.edit')}
              aria-label={`${t('common.edit')}: ${p.name}`}
              data-testid={`edit-profile-${p.name}`}
            >
              ✎
            </button>
            <button
              className={iconBtn}
              onClick={() => void api.invoke('profiles:checkAuth', p.id)}
              title={t('auth.check')}
              aria-label={`${t('auth.check')}: ${p.name}`}
            >
              ↻
            </button>
            <button
              className={`${iconBtn} hover:text-danger`}
              onClick={() => props.onRemoveProfile(p)}
              title={t('common.remove')}
              aria-label={`${t('common.remove')}: ${p.name}`}
            >
              ✕
            </button>
          </span>
        </div>
        <div className="flex items-center gap-2 pl-7">
          <AuthStatusLabel status={p.authStatus} />
          {p.accountEmail && <span className="truncate text-xs text-muted">{p.accountEmail}</span>}
        </div>
        {open && (
          <ul className="mt-1 space-y-1 pl-4">
            {projects.map((pr) => {
              const pkey = `${key}:${pr.id}`;
              const popen = !collapsed[pkey];
              return (
                <li key={pr.id}>
                  <div className="group flex items-center gap-1">
                    <Twisty open={popen} onToggle={() => toggle(pkey)} label={pr.name} />
                    <span className="min-w-0 flex-1 truncate" title={pr.path}>
                      {pr.name}
                    </span>
                    {pr.pinnedProfileId === p.id && (
                      <span className="text-[11px] text-muted" title={t('sidebar.pinnedHere')}>
                        📌<span className="sr-only">{t('sidebar.pinnedHere')}</span>
                      </span>
                    )}
                    <button
                      className={`${iconBtn} text-sm`}
                      onClick={() => props.onNewSession(pr.id, p.id)}
                      title={t('sidebar.newSessionWith', { project: pr.name, profile: p.name })}
                      aria-label={t('sidebar.newSessionWith', { project: pr.name, profile: p.name })}
                      data-testid={`new-session-${pr.name}-${p.name}`}
                    >
                      ＋
                    </button>
                  </div>
                  {popen && (
                    <div className="pl-4">
                      {sessionList(
                        pkey,
                        mine.filter((s) => s.projectId === pr.id),
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {loose.length > 0 && (
              <li>
                <div className="flex items-center gap-1">
                  <Twisty
                    open={!collapsed[`${key}:loose`]}
                    onToggle={() => toggle(`${key}:loose`)}
                    label={t('sidebar.otherSessions')}
                  />
                  <span className="min-w-0 flex-1 truncate text-muted">{t('sidebar.otherSessions')}</span>
                </div>
                {!collapsed[`${key}:loose`] && (
                  <div className="pl-4">{sessionList(`${key}:loose`, loose)}</div>
                )}
              </li>
            )}
            {projects.length === 0 && loose.length === 0 && (
              <li className="px-2 text-xs text-muted">{t('sidebar.noSessions')}</li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav
      className="flex h-full shrink-0 flex-col overflow-y-auto border-r border-line bg-panel pb-4"
      style={{ width: props.width }}
      aria-label="sidebar"
      data-testid="sidebar"
    >
      <SectionHeader
        title={t('sidebar.profiles')}
        action={t('sidebar.addProfile')}
        onAction={props.onAddProfile}
        testId="add-profile"
      />
      <ul className="space-y-2 px-2" data-testid="profile-list">
        {props.profiles.map(profileNode)}
      </ul>

      <SectionHeader
        title={t('sidebar.projects')}
        action={t('sidebar.addProject')}
        onAction={props.onAddProject}
        testId="add-project"
      />
      {props.projects.length === 0 && <p className="px-4 text-xs text-muted">{t('sidebar.noProjects')}</p>}
      <ul className="space-y-1.5 px-2" data-testid="project-list">
        {props.projects.map((pr) => (
          <li key={pr.id} className="group rounded border border-line/60 bg-bg/40 px-2 py-1.5">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-medium" title={pr.path}>
                {pr.name}
              </span>
              <button
                className={`${iconBtn} text-sm`}
                onClick={() => props.onNewSession(pr.id)}
                title={t('sidebar.newSessionIn')}
                aria-label={`${t('sidebar.newSessionIn')}: ${pr.name}`}
                data-testid={`new-session-${pr.name}`}
              >
                ＋
              </button>
              <button
                className={iconBtn}
                onClick={() => props.onEditProject(pr)}
                title={t('common.settings')}
                aria-label={`${t('common.settings')}: ${pr.name}`}
              >
                ⚙
              </button>
              <button
                className={`${iconBtn} hover:text-danger`}
                onClick={() => props.onRemoveProject(pr)}
                aria-label={`${t('common.remove')}: ${pr.name}`}
                title={t('common.remove')}
              >
                ✕
              </button>
            </div>
            <div className="mt-1 text-xs">
              <span className="sr-only">{t('sidebar.pinned')}</span>
              <ProfileSelect
                profiles={props.profiles}
                value={pr.pinnedProfileId ?? ''}
                allowNone
                onChange={(id) => void api.invoke('projects:update', pr.id, { pinnedProfileId: id || null })}
              />
            </div>
          </li>
        ))}
      </ul>
    </nav>
  );
}
