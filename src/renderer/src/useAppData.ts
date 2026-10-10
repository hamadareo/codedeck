import { useCallback, useEffect, useState } from 'react';
import type { Activity, EnvInfo, Profile, Project, PtyState, Session } from '@shared/types';
import type { ProfileUsage } from '@shared/usage';
import { api } from './api';

export interface AppData {
  env: EnvInfo | null;
  profiles: Profile[];
  projects: Project[];
  sessions: Session[];
  ptyStates: Record<string, PtyState>;
  exitCodes: Record<string, number | null>;
  activities: Record<string, Activity>;
  /** Sessions shown in their own window. */
  popouts: string[];
  usage: ProfileUsage[];
  loaded: boolean;
  refresh(what: 'profiles' | 'projects' | 'sessions'): Promise<void>;
}

/**
 * A finished turn counts as seen once its session is in the focused pane of a
 * visible window ("done" → "waiting"); otherwise it stays "done" to draw attention.
 */
export function useSeen(sessionId: string | null, activity: Activity | undefined): void {
  useEffect(() => {
    if (!sessionId || activity !== 'done') return;
    const check = () => {
      if (document.visibilityState === 'visible') api.send('session:seen', sessionId);
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [sessionId, activity]);
}

/** Main owns all state; the renderer re-fetches a list whenever main says it changed. */
export function useAppData(): AppData {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ptyStates, setPtyStates] = useState<Record<string, PtyState>>({});
  const [exitCodes, setExitCodes] = useState<Record<string, number | null>>({});
  const [activities, setActivities] = useState<Record<string, Activity>>({});
  const [popouts, setPopouts] = useState<string[]>([]);
  const [usage, setUsage] = useState<ProfileUsage[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (what: 'profiles' | 'projects' | 'sessions') => {
    if (what === 'profiles') setProfiles(await api.invoke('profiles:list'));
    if (what === 'projects') setProjects(await api.invoke('projects:list'));
    if (what === 'sessions') setSessions(await api.invoke('sessions:list'));
  }, []);

  useEffect(() => {
    const offs = [
      // Tasks and prompts are loaded by the panels that show them.
      api.on('state:changed', (what) => {
        if (what === 'profiles' || what === 'projects' || what === 'sessions') void refresh(what);
      }),
      api.on('pty:state', (id, state, code) => {
        setPtyStates((s) => ({ ...s, [id]: state }));
        if (state === 'exited') setExitCodes((c) => ({ ...c, [id]: code }));
        if (state !== 'running')
          setActivities((a) => {
            if (!(id in a)) return a;
            const rest = { ...a };
            delete rest[id];
            return rest;
          });
      }),
      api.on('activity:changed', (id, activity) => setActivities((a) => ({ ...a, [id]: activity }))),
      api.on('windows:changed', setPopouts),
      api.on('usage:changed', setUsage),
    ];
    void api.invoke('usage:list').then(setUsage);
    void (async () => {
      const [p, pr, s, st, act, pop] = await Promise.all([
        api.invoke('profiles:list'),
        api.invoke('projects:list'),
        api.invoke('sessions:list'),
        api.invoke('pty:states'),
        api.invoke('activity:list'),
        api.invoke('window:popouts'),
      ]);
      setProfiles(p);
      setProjects(pr);
      setSessions(s);
      setPtyStates(st);
      setActivities(act);
      setPopouts(pop);
      setLoaded(true);
      setEnv(await api.invoke('env:info'));
    })();
    return () => offs.forEach((off) => off());
  }, [refresh]);

  return {
    env,
    profiles,
    projects,
    sessions,
    ptyStates,
    exitCodes,
    activities,
    popouts,
    usage,
    loaded,
    refresh,
  };
}
