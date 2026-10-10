import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { CodeDeckService, type ChangeKind } from '../../src/main/service';
import { SettingsStore } from '../../src/main/settings';
import { shouldResume, transcriptExists } from '../../src/main/sessions/transcript';

let tmp: string;
let db: Db;
let svc: CodeDeckService;
let changes: ChangeKind[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck test テスト '));
  db = openDatabase(path.join(tmp, 'codedeck.db'));
  changes = [];
  svc = new CodeDeckService({
    db,
    settings: new SettingsStore(path.join(tmp, 'settings.json')),
    ptyEvents: { onData: () => {}, onState: () => {} },
    onChange: (k) => changes.push(k),
    home: tmp,
  });
});

afterEach(() => {
  svc.shutdown();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('profiles', () => {
  it('creates a dedicated config dir per profile with kind-based default colors', () => {
    const a = svc.createProfile({ name: '個人', kind: 'personal' });
    const b = svc.createProfile({ name: 'Team X', kind: 'team' });
    expect(a.configDir).toBe(path.join(tmp, '.codedeck', 'profiles', '個人'));
    expect(fs.existsSync(a.configDir)).toBe(true);
    expect(fs.existsSync(b.configDir)).toBe(true);
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.color).toBe('#2563eb');
    expect(b.color).toBe('#16a34a');
    expect(changes).toContain('profiles');
  });

  it('rejects duplicate names', () => {
    svc.createProfile({ name: 'team', kind: 'team' });
    expect(() => svc.createProfile({ name: 'TEAM', kind: 'team' })).toThrow('profile.error.nameTaken');
  });

  it('removing a profile keeps its config dir (the login lives there) and drops its sessions', () => {
    const p = svc.createProfile({ name: 'p', kind: 'personal' });
    fs.writeFileSync(path.join(p.configDir, 'marker'), 'x');
    svc.createSession({ profileId: p.id, cwd: tmp });
    const { configDir } = svc.removeProfile(p.id);
    expect(fs.existsSync(path.join(configDir, 'marker'))).toBe(true);
    expect(svc.profiles.list()).toHaveLength(0);
    expect(svc.sessions.list()).toHaveLength(0);
  });
});

describe('projects and sessions', () => {
  it('regression: each session keeps the profile it was created with', () => {
    const personal = svc.createProfile({ name: 'personal', kind: 'personal' });
    const team = svc.createProfile({ name: 'team', kind: 'team' });
    const pr = svc.createProject({ name: 'app', path: tmp, pinnedProfileId: team.id });
    const s1 = svc.createSession({ profileId: team.id, projectId: pr.id, cwd: pr.path });
    const s2 = svc.createSession({ profileId: personal.id, projectId: pr.id, cwd: pr.path });
    const reloaded = new Map(svc.sessions.list().map((s) => [s.id, s]));
    expect(reloaded.get(s1.id)?.profileId).toBe(team.id);
    expect(reloaded.get(s2.id)?.profileId).toBe(personal.id);
    expect(s1.title).toBe('app #1');
    expect(s2.title).toBe('app #2');
  });

  it('deleting a pinned profile clears the pin; deleting a project keeps its sessions', () => {
    const p = svc.createProfile({ name: 'p', kind: 'personal' });
    const q = svc.createProfile({ name: 'q', kind: 'team' });
    const pr = svc.createProject({ name: 'app', path: tmp, pinnedProfileId: p.id });
    const s = svc.createSession({ profileId: q.id, projectId: pr.id, cwd: tmp });
    svc.removeProfile(p.id);
    expect(svc.projects.get(pr.id)?.pinnedProfileId).toBeNull();
    svc.removeProject(pr.id);
    expect(svc.sessions.get(s.id)?.projectId).toBeNull();
  });

  it('open/closed state survives a reopen of the database (restore after restart)', () => {
    const p = svc.createProfile({ name: 'p', kind: 'personal' });
    const a = svc.createSession({ profileId: p.id, cwd: tmp });
    const b = svc.createSession({ profileId: p.id, cwd: tmp });
    svc.closeSession(b.id);
    db.close();
    db = openDatabase(path.join(tmp, 'codedeck.db'));
    svc = new CodeDeckService({
      db,
      settings: new SettingsStore(path.join(tmp, 'settings.json')),
      ptyEvents: { onData: () => {}, onState: () => {} },
      onChange: () => {},
      home: tmp,
    });
    const open = svc.sessions
      .list()
      .filter((s) => s.open)
      .map((s) => s.id);
    expect(open).toEqual([a.id]);
  });
});

describe('notes and renaming', () => {
  it('stores one note per project and drops it with the project', () => {
    const pr = svc.createProject({ name: 'app', path: tmp });
    expect(svc.getNote(pr.id)).toBe('');
    svc.setNote(pr.id, 'メモ\nline 2');
    expect(svc.getNote(pr.id)).toBe('メモ\nline 2');
    svc.removeProject(pr.id);
    expect(svc.notes.get(pr.id)).toBe('');
    expect(() => svc.setNote(pr.id, 'x')).toThrow();
  });

  it('renames a session; an empty title is rejected', () => {
    const p = svc.createProfile({ name: 'p', kind: 'personal' });
    const s = svc.createSession({ profileId: p.id, cwd: tmp });
    expect(svc.renameSession(s.id, '  review  ').title).toBe('review');
    expect(() => svc.renameSession(s.id, '  ')).toThrow('session.error.titleRequired');
  });

  it('activity events are ignored for sessions that are not running', () => {
    const p = svc.createProfile({ name: 'p', kind: 'personal' });
    const s = svc.createSession({ profileId: p.id, cwd: tmp });
    svc.applyActivity(s.id, 'prompt');
    expect(svc.activity(s.id)).toBe('unknown');
  });
});

describe('restore rule', () => {
  it('resumes only when claude saved a transcript for the id', () => {
    const dir = path.join(tmp, 'cfg');
    expect(transcriptExists(dir, 'abc')).toBe(false);
    fs.mkdirSync(path.join(dir, 'projects', 'C--work-app'), { recursive: true });
    expect(shouldResume(dir, 'abc')).toBe(false);
    fs.writeFileSync(path.join(dir, 'projects', 'C--work-app', 'abc.jsonl'), '{}\n');
    expect(shouldResume(dir, 'abc')).toBe(true);
    expect(shouldResume(dir, 'abcd')).toBe(false);
  });
});

describe('migrations', () => {
  it('are idempotent', () => {
    db.close();
    db = openDatabase(path.join(tmp, 'codedeck.db'));
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(v.user_version).toBe(5);
  });
});
