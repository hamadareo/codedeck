import type { AuthStatus, Profile, SessionStatus } from '@shared/types';
import { readableTextColor } from '@shared/profileRules';
import { STATUS_STYLE } from '@shared/status';
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

const TONE: Record<string, string> = {
  muted: 'text-muted',
  ok: 'text-ok',
  accent: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
};

/** Session status with icon + text, never color alone (§4). `compact` keeps the text for screen readers only. */
export function SessionStatusLabel({ status, compact }: { status: SessionStatus; compact?: boolean }) {
  const t = useT();
  const s = STATUS_STYLE[status];
  const label = t(`status.${status}`);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${TONE[s.tone]}`}
      data-testid="session-status"
      data-status={status}
      title={label}
    >
      <span aria-hidden className={status === 'working' ? 'cd-spin' : ''}>
        {s.icon}
      </span>
      <span className={compact ? 'sr-only' : ''}>{label}</span>
    </span>
  );
}
