import { randomUUID } from 'node:crypto';
import { translate, type Locale } from '@shared/i18n';
import { isSessionKind, type NotificationRecord, type NotifyKind, type NotifySettings } from '@shared/notify';

export interface NotifierDeps {
  settings(): { notifications: NotifySettings; locale: Locale };
  /** Shows an OS notification; `onClick` brings the app (and session) forward. */
  showOs(title: string, body: string, onClick: () => void): void;
  /** In-app banner in every window. */
  showInApp(record: NotificationRecord): void;
  /** Is any CodeDeck window focused? (session alerts are OS-only and skipped while the user is here) */
  appFocused(): boolean;
  onClick(record: NotificationRecord): void;
}

const HISTORY = 100;

/** Sends notifications by kind and setting, and keeps a short history (shown in the Usage panel). */
export class Notifier {
  private readonly history: NotificationRecord[] = [];

  constructor(private readonly deps: NotifierDeps) {}

  list(): NotificationRecord[] {
    return [...this.history].reverse();
  }

  notify(
    kind: NotifyKind,
    vars: Record<string, string | number>,
    ref: { profileId?: string | null; sessionId?: string | null } = {},
  ): NotificationRecord | null {
    const { notifications: s, locale } = this.deps.settings();
    if (!s.kinds[kind]) return null;
    const v = { ...vars };
    if (typeof v.window === 'string') v.window = translate(locale, `usage.window.${v.window}`);
    const title = translate(locale, `notify.${kind}.title`, v);
    const body = translate(locale, `notify.${kind}.body`, v);
    const session = isSessionKind(kind);
    // Session alerts only matter when the user is elsewhere; usage alerts always show.
    const os = s.os && (!session || !this.deps.appFocused());
    const inApp = s.inApp && !session;
    if (!os && !inApp) return null;
    const record: NotificationRecord = {
      id: randomUUID(),
      kind,
      title,
      body,
      at: Date.now(),
      profileId: ref.profileId ?? null,
      sessionId: ref.sessionId ?? null,
      shown: { os, inApp },
    };
    this.history.push(record);
    if (this.history.length > HISTORY) this.history.shift();
    if (os) this.deps.showOs(title, body, () => this.deps.onClick(record));
    if (inApp) this.deps.showInApp(record);
    return record;
  }
}
