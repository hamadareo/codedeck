import { useEffect, useMemo } from 'react';
import { displayStatus } from '@shared/status';
import { platformOf } from '@shared/keymap';
import { api } from './api';
import { LocaleContext, useT } from './i18n';
import { SettingsContext, useSettings } from './settings';
import { useAppData, useSeen } from './useAppData';
import { setAppActionHandler, setPlatform } from './terminal/registry';
import { TerminalView } from './terminal/TerminalView';
import { ProfileBadge, SessionStatusLabel } from './ui/badges';

/** A window showing one session (§4 pop-out). Closing it returns the session to the main window. */
export function PopoutApp({ sessionId }: { sessionId: string }) {
  const { settings } = useSettings();
  return (
    <SettingsContext.Provider value={settings}>
      <LocaleContext.Provider value={settings?.locale ?? 'ja'}>
        <Popout sessionId={sessionId} />
      </LocaleContext.Provider>
    </SettingsContext.Provider>
  );
}

function Popout({ sessionId }: { sessionId: string }) {
  const t = useT();
  const data = useAppData();
  const session = useMemo(() => data.sessions.find((s) => s.id === sessionId), [data.sessions, sessionId]);
  const profile = data.profiles.find((p) => p.id === session?.profileId);
  const platform = platformOf(data.env?.platform ?? '');
  useSeen(session ? sessionId : null, data.activities[sessionId]);

  useEffect(() => setPlatform(platform), [platform]);
  useEffect(() => {
    // In this window, the pop-out shortcut docks the session back.
    setAppActionHandler((a) => {
      if (a === 'popout' || a === 'closeTab') void api.invoke('window:dock', sessionId);
    });
  }, [sessionId]);
  useEffect(() => {
    if (session) document.title = `${session.title} — CodeDeck`;
  }, [session]);

  if (!session) return null;
  const status = displayStatus(
    session,
    data.ptyStates[session.id] ?? 'idle',
    data.activities[session.id] ?? 'unknown',
    data.exitCodes[session.id] ?? null,
  );
  return (
    <div
      className="flex h-full flex-col"
      style={{ borderLeft: `3px solid ${profile?.color ?? 'transparent'}` }}
      data-testid="popout"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-xs">
        <ProfileBadge profile={profile} small />
        <span className="min-w-0 truncate font-medium">{session.title}</span>
        <SessionStatusLabel status={status} />
        <span className="font-path min-w-0 flex-1 truncate text-muted">{session.cwd}</span>
        <button
          className="rounded border border-line px-2 py-0.5 hover:bg-panel-2"
          onClick={() => void api.invoke('window:dock', session.id)}
          data-testid="dock"
        >
          {t('pane.dock')}
        </button>
      </header>
      <div className="min-h-0 flex-1 p-1">
        <TerminalView
          session={session}
          focused
          ptyState={data.ptyStates[session.id] ?? 'idle'}
          exitCode={data.exitCodes[session.id] ?? null}
        />
      </div>
    </div>
  );
}
