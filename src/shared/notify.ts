/** Notification kinds (§5 通知, §7). Each can be switched on/off in Settings. */
export type NotifyKind =
  'usageThreshold' | 'usageReset' | 'limitReached' | 'sessionDone' | 'sessionApproval' | 'sessionError';

export const NOTIFY_KINDS: NotifyKind[] = [
  'usageThreshold',
  'limitReached',
  'usageReset',
  'sessionDone',
  'sessionApproval',
  'sessionError',
];

export interface NotifySettings {
  /** OS notification center / Windows toast. */
  os: boolean;
  /** Banner inside the app. */
  inApp: boolean;
  kinds: Record<NotifyKind, boolean>;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  os: true,
  inApp: true,
  kinds: {
    usageThreshold: true,
    usageReset: true,
    limitReached: true,
    sessionDone: true,
    sessionApproval: true,
    sessionError: true,
  },
};

export interface NotificationRecord {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  at: number;
  profileId: string | null;
  sessionId: string | null;
  /** Where it was shown. */
  shown: { os: boolean; inApp: boolean };
}

/** Session notifications are about one session; usage ones are about a profile and show in-app too. */
export function isSessionKind(k: NotifyKind): boolean {
  return k === 'sessionDone' || k === 'sessionApproval' || k === 'sessionError';
}
