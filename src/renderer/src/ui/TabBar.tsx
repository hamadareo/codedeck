import type { Profile, Session, SessionStatus } from '@shared/types';
import { useT } from '../i18n';
import { ProfileBadge, SessionStatusLabel } from './badges';

export const DND_SESSION = 'application/x-codedeck-session';
export const DND_PANE = 'application/x-codedeck-pane';

interface Props {
  tabs: Session[];
  profiles: Profile[];
  statusOf(id: string): SessionStatus;
  activeId: string | null;
  /** Sessions currently shown in some pane (or their own window). */
  shownIds: Set<string>;
  popouts: string[];
  newSessionHint: string;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

export function TabBar(props: Props) {
  const t = useT();
  const byId = new Map(props.profiles.map((p) => [p.id, p]));
  return (
    <div
      className="flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel"
      role="tablist"
    >
      {props.tabs.map((s) => {
        const profile = byId.get(s.profileId);
        const active = s.id === props.activeId;
        const poppedOut = props.popouts.includes(s.id);
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_SESSION, s.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className={`group flex max-w-72 min-w-44 cursor-pointer items-center gap-2 border-r border-line px-3 ${
              active
                ? 'bg-bg'
                : props.shownIds.has(s.id)
                  ? 'bg-panel-2/50 hover:bg-panel-2'
                  : 'hover:bg-panel-2'
            }`}
            style={{ borderTop: `3px solid ${profile?.color ?? 'transparent'}` }}
            onClick={() => props.onSelect(s.id)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSelect(s.id)}
            data-testid="session-tab"
            data-session-id={s.id}
          >
            <ProfileBadge profile={profile} small />
            <span className="min-w-0 flex-1 truncate">
              {poppedOut && (
                <span aria-label={t('pane.poppedOut')} title={t('pane.poppedOut')}>
                  ⧉{' '}
                </span>
              )}
              {s.title}
            </span>
            <SessionStatusLabel status={props.statusOf(s.id)} />
            <button
              className="rounded px-1 text-muted opacity-60 hover:bg-panel-2 hover:text-fg group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(s.id);
              }}
              aria-label={`${t('session.close')}: ${s.title}`}
              title={t('session.close')}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        className="px-3 text-lg text-muted hover:bg-panel-2 hover:text-fg"
        onClick={props.onNew}
        title={`${t('session.new')} (${props.newSessionHint})`}
        aria-label={t('session.new')}
        data-testid="new-session"
      >
        ＋
      </button>
    </div>
  );
}
