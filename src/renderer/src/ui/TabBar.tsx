import type { Profile, PtyState, Session } from '@shared/types';
import { useT } from '../i18n';
import { ProfileBadge, SessionStateLabel } from './badges';

interface Props {
  tabs: Session[];
  profiles: Profile[];
  ptyStates: Record<string, PtyState>;
  activeId: string | null;
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
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`group flex max-w-72 min-w-44 cursor-pointer items-center gap-2 border-r border-line px-3 ${
              active ? 'bg-bg' : 'hover:bg-panel-2'
            }`}
            style={{ borderTop: `3px solid ${profile?.color ?? 'transparent'}` }}
            onClick={() => props.onSelect(s.id)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSelect(s.id)}
            data-testid="session-tab"
          >
            <ProfileBadge profile={profile} small />
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            <SessionStateLabel session={s} state={props.ptyStates[s.id] ?? 'idle'} />
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
