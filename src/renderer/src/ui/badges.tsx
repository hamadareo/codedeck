import type { AuthStatus, Profile, PtyState, Session } from '@shared/types';
import { readableTextColor } from '@shared/profileRules';
import { useT } from '../i18n';

/** Profile badge: color + name, shown on every tab and pane (§3-5). */
export function ProfileBadge({ profile, small }: { profile: Profile | undefined; small?: boolean }) {
  if (!profile) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded font-semibold ${
        small ? 'px-1.5 text-[11px]' : 'px-2 py-0.5 text-xs'
      }`}
      style={{ backgroundColor: profile.color, color: readableTextColor(profile.color) }}
      data-testid="profile-badge"
    >
      {profile.icon && <span aria-hidden>{profile.icon}</span>}
      {profile.name}
    </span>
  );
}

const AUTH_ICON: Record<AuthStatus, string> = { connected: '●', logged_out: '○', unknown: '◌' };
const AUTH_COLOR: Record<AuthStatus, string> = {
  connected: 'text-ok',
  logged_out: 'text-warn',
  unknown: 'text-muted',
};

export function AuthStatusLabel({ status }: { status: AuthStatus }) {
  const t = useT();
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${AUTH_COLOR[status]}`}>
      <span aria-hidden>{AUTH_ICON[status]}</span>
      {t(`auth.${status}`)}
    </span>
  );
}

/** Session state with icon + text, never color alone (§4). Phase 2 adds waiting/approval/limit states. */
export function SessionStateLabel({ session, state }: { session: Session; state: PtyState }) {
  const t = useT();
  const key = session.location === 'external' ? 'external' : state;
  const icon = { idle: '○', running: '▶', exited: '■', external: '↗' }[key];
  const color = { idle: 'text-muted', running: 'text-ok', exited: 'text-muted', external: 'text-accent' }[
    key
  ];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${color}`}>
      <span aria-hidden>{icon}</span>
      {t(`session.state.${key}`)}
    </span>
  );
}
