import { useCallback, useEffect, useState } from 'react';
import type { EnvInfo, Profile, Project, PtyState, Session } from '@shared/types';
import { api } from './api';

export interface AppData {
  env: EnvInfo | null;
  profiles: Profile[];
  projects: Project[];
  sessions: Session[];
  ptyStates: Record<string, PtyState>;
  exitCodes: Record<string, number | null>;
  loaded: boolean;
  refresh(what: 'profiles' | 'projects' | 'sessions'): Promise<void>;
}

/** Main owns all state; the renderer re-fetches a list whenever main says it changed. */
export function useAppData(): AppData {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ptyStates, setPtyStates] = useState<Record<string, PtyState>>({});
  const [exitCodes, setExitCodes] = useState<Record<string, number | null>>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (what: 'profiles' | 'projects' | 'sessions') => {
    if (what === 'profiles') setProfiles(await api.invoke('profiles:list'));
    if (what === 'projects') setProjects(await api.invoke('projects:list'));
    if (what === 'sessions') setSessions(await api.invoke('sessions:list'));
  }, []);

  useEffect(() => {
    const offChange = api.on('state:changed', (what) => void refresh(what));
    const offState = api.on('pty:state', (id, state, code) => {
      setPtyStates((s) => ({ ...s, [id]: state }));
      if (state === 'exited') setExitCodes((c) => ({ ...c, [id]: code }));
    });
    void (async () => {
      const [p, pr, s, st] = await Promise.all([
        api.invoke('profiles:list'),
        api.invoke('projects:list'),
        api.invoke('sessions:list'),
        api.invoke('pty:states'),
      ]);
      setProfiles(p);
      setProjects(pr);
      setSessions(s);
      setPtyStates(st);
      setLoaded(true);
      setEnv(await api.invoke('env:info'));
    })();
    return () => {
      offChange();
      offState();
    };
  }, [refresh]);

  return { env, profiles, projects, sessions, ptyStates, exitCodes, loaded, refresh };
}
