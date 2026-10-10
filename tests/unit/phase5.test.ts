import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { CodeDeckService } from '../../src/main/service';
import { SettingsStore } from '../../src/main/settings';
import { gitCommitAll, gitDiff, gitStatus, parseNumstat, parseStatusV2 } from '../../src/main/git';
import { COMMAND_DIR, syncCommands } from '../../src/main/prompts/commandSync';
import {
  isSafeSkillName,
  listSkills,
  parseMcpList,
  parseSkillFrontMatter,
  setSkillEnabled,
} from '../../src/main/extensions';
import { commandFile, commandSlug, expandPrompt, parsePromptExport, promptVariables } from '@shared/prompts';
import { computeStats } from '@shared/stats';
import type { Prompt, Session } from '@shared/types';

let tmp = '';
const mk = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cd p5 ${label} テスト `));
const rm = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold a PTY's cwd for a moment
  }
};

describe('tasks', () => {
  let db: Db;
  let svc: CodeDeckService;
  beforeEach(() => {
    tmp = mk('tasks');
    db = openDatabase(path.join(tmp, 'db'));
    svc = new CodeDeckService({
      db,
      settings: new SettingsStore(path.join(tmp, 's.json')),
      ptyEvents: { onData: () => {}, onState: () => {} },
      onChange: () => {},
      home: tmp,
    });
  });
  afterEach(() => {
    svc.shutdown();
    db.close();
    rm(tmp);
  });

  it('create, reorder, status, validation, cascade with the project', () => {
    const pr = svc.createProject({ name: 'app', path: tmp });
    const a = svc.createTask(pr.id, 'first');
    const b = svc.createTask(pr.id, '  second  ', 'details');
    const c = svc.createTask(pr.id, 'third');
    expect(svc.tasks.list(pr.id).map((t) => t.title)).toEqual(['first', 'second', 'third']);
    expect(b.body).toBe('details');
    expect(svc.moveTask(c.id, -1).map((t) => t.title)).toEqual(['first', 'third', 'second']);
    expect(svc.moveTask(a.id, -1).map((t) => t.title)).toEqual(['first', 'third', 'second']); // already first
    expect(svc.updateTask(a.id, { status: 'done' }).status).toBe('done');
    expect(() => svc.createTask(pr.id, '   ')).toThrow('task.error.titleRequired');
    expect(() => svc.updateTask(a.id, { status: 'nope' as never })).toThrow();
    svc.removeProject(pr.id);
    expect(svc.tasks.list(pr.id)).toEqual([]);
  });
});

describe('git', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });

  it('parses porcelain v2 and numstat (renames, untracked, spaces)', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a a src/app.ts',
      '2 R. N... 100644 100644 100644 a a R100 new name.ts',
      'old name.ts',
      '? notes 日本語.md',
      '',
    ].join('\0');
    const s = parseStatusV2(out);
    expect(s).toMatchObject({ branch: 'main', ahead: 2, behind: 1 });
    expect(s.files.map((f) => [f.status, f.path])).toEqual([
      ['M', 'src/app.ts'],
      ['R', 'new name.ts'],
      ['?', 'notes 日本語.md'],
    ]);
    const n = parseNumstat(
      ['3\t1\tsrc/app.ts', '-\t-\timg.png', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0'),
    );
    expect(n.get('src/app.ts')).toEqual({ added: 3, deleted: 1 });
    expect(n.get('img.png')).toEqual({ added: null, deleted: null });
    expect(n.get('new.ts')).toEqual({ added: 0, deleted: 0 });
  });

  it.skipIf(!hasGit)('status, diff (also untracked), and commit in a real repository', async () => {
    const repo = mk('repo');
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'config', 'user.email', 't@example.com');
    g(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'hello\n');

    const st = await gitStatus(repo);
    expect(st).toMatchObject({ isRepo: true, branch: 'main' });
    expect(st.files.find((f) => f.path === 'a.txt')).toMatchObject({ status: 'M', added: 2, deleted: 1 });
    expect(st.files.find((f) => f.path === 'new file.txt')?.status).toBe('?');
    expect(await gitDiff(repo, 'a.txt')).toMatch(/-two\n\+TWO\n\+three/);
    expect(await gitDiff(repo, 'new file.txt')).toMatch(/\+hello/);
    await expect(gitDiff(repo, '--output=x')).rejects.toThrow();

    await expect(gitCommitAll(repo, '  ')).rejects.toThrow('git.error.messageRequired');
    const r = await gitCommitAll(repo, 'Update a, add new file');
    expect(r.ok).toBe(true);
    expect((await gitStatus(repo)).files).toEqual([]);
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('Update a, add new file');
    expect((await gitStatus(mk('plain'))).isRepo).toBe(false);
    rm(repo);
  });
});

describe('prompt library', () => {
  const prompt = (name: string, body: string, asCommand = true): Prompt => ({
    id: `id-${name}-0000000`,
    name,
    body,
    asCommand,
    sort: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it('variables, defaults and built-ins', () => {
    const body = 'Review {{file}} on {{branch}} for {{focus:security}} in {{project}} ({{file}})';
    expect(promptVariables(body)).toEqual([
      { name: 'file', default: '' },
      { name: 'focus', default: 'security' },
    ]);
    expect(expandPrompt(body, { file: 'a.ts', branch: 'main', project: 'app' })).toBe(
      'Review a.ts on main for security in app (a.ts)',
    );
    expect(promptVariables('{{名前}} を確認')).toEqual([{ name: '名前', default: '' }]);
  });

  it('command names are safe; files carry positional arguments', () => {
    expect(commandSlug('Code Review!', 'x')).toBe('code-review');
    expect(commandSlug('../../evil', 'x')).toBe('evil');
    expect(commandSlug('レビュー', 'abcdef123')).toBe('prompt-abcdef12');
    const f = commandFile(prompt('Review', 'Review {{file}} for {{focus:bugs}} on {{branch}}'));
    expect(f).toContain('argument-hint: "<file> <focus>"');
    expect(f).toContain('Review $1 for $2 on the current git branch');
  });

  it('sync writes only into commands/codedeck and removes only its own files', () => {
    const cfg = mk('cfg');
    const mine = path.join(cfg, COMMAND_DIR);
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'users-own.md'), 'not ours');
    let r = syncCommands(cfg, [prompt('Review', 'Look at {{x}}'), prompt('Off', 'nope', false)]);
    expect(r.written).toEqual(['review']);
    expect(fs.readFileSync(path.join(mine, 'review.md'), 'utf8')).toContain('Look at $1');
    r = syncCommands(cfg, []);
    expect(r.removed).toEqual(['review']);
    expect(fs.existsSync(path.join(mine, 'users-own.md'))).toBe(true);
    expect(fs.readdirSync(path.join(cfg, 'commands'))).toEqual(['codedeck']);
    rm(cfg);
  });

  it('import validates the file', () => {
    expect(() => parsePromptExport('{"format":"other"}')).toThrow('prompts.error.badFile');
    expect(
      parsePromptExport(
        JSON.stringify({
          format: 'codedeck-prompts',
          version: 1,
          prompts: [{ name: ' a ', body: 'b' }, { name: 1 }],
        }),
      ),
    ).toEqual([{ name: 'a', body: 'b', asCommand: false }]);
  });
});

describe('skills and MCP', () => {
  it('lists skills; toggles only profile skills by moving folders; refuses traversal', () => {
    const cfg = mk('skills');
    const proj = mk('proj');
    fs.mkdirSync(path.join(cfg, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: "Reviews code"\n---\nbody',
    );
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'deploy'), { recursive: true });
    expect(listSkills(cfg, proj)).toEqual([
      { name: 'review', description: 'Reviews code', enabled: true, scope: 'profile' },
      { name: 'deploy', description: '', enabled: true, scope: 'project' },
    ]);
    setSkillEnabled(cfg, 'review', false);
    expect(listSkills(cfg)[0]).toMatchObject({ name: 'review', enabled: false });
    expect(fs.existsSync(path.join(cfg, 'skills-disabled', 'review', 'SKILL.md'))).toBe(true);
    setSkillEnabled(cfg, 'review', true);
    expect(listSkills(cfg)[0]!.enabled).toBe(true);
    expect(() => setSkillEnabled(cfg, '../x', false)).toThrow('skills.error.badName');
    expect(isSafeSkillName('..')).toBe(false);
    expect(isSafeSkillName('a/b')).toBe(false);
    expect(parseSkillFrontMatter('no front matter')).toEqual({});
    rm(cfg);
    rm(proj);
  });

  it('parses `claude mcp list`', () => {
    const out = [
      'Checking MCP server health…',
      '',
      'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
      'github: npx -y @modelcontextprotocol/server-github - ✗ Failed to connect',
      'linear: https://mcp.linear.app/sse - ⚠ Needs authentication',
    ].join('\n');
    expect(parseMcpList(out).map((m) => [m.name, m.status])).toEqual([
      ['claude.ai Claude Docs', 'connected'],
      ['github', 'failed'],
      ['linear', 'needs-auth'],
    ]);
  });
});

describe('statistics', () => {
  it('aggregates per project and profile; work time is clipped to the range', () => {
    const DAY = 86_400_000;
    const now = Date.parse('2026-10-10T12:00:00Z');
    const s = (id: string, projectId: string | null, profileId: string): Session => ({
      id,
      title: id,
      projectId,
      profileId,
      cwd: '/',
      open: true,
      location: 'embedded',
      started: true,
      createdAt: 0,
      lastActiveAt: 0,
      sshHostId: null,
    });
    const stats = computeStats({
      days: 7,
      now,
      tzOffsetMin: -540, // JST
      entries: new Map([
        [
          'p1',
          [
            { ts: now - DAY, tokens: 100, session: 's1' },
            { ts: now - 2 * DAY, tokens: 50, session: 's2' },
            { ts: now - 10 * DAY, tokens: 999, session: 's1' }, // outside 7 days
            { ts: now - DAY, tokens: 7, session: 'external' },
          ],
        ],
        ['p2', [{ ts: now - 3 * 3_600_000, tokens: 30, session: 's3' }]],
      ]),
      sessions: [s('s1', 'pa', 'p1'), s('s2', null, 'p1'), s('s3', 'pa', 'p2')],
      projects: [{ id: 'pa', name: 'app', path: '/', pinnedProfileId: null, createdAt: 0 }],
      profiles: [{ id: 'p1', name: '個人' } as never, { id: 'p2', name: 'チーム' } as never],
      work: [
        { sessionId: 's1', startedAt: now - 2 * 3_600_000, endedAt: now - 3_600_000 },
        { sessionId: 's3', startedAt: now - 8 * DAY, endedAt: now - 7 * DAY + 60_000 }, // 1 min inside
      ],
      labels: { outside: 'outside', noProject: 'none' },
    });
    expect(stats.byProject.map((r) => [r.label, r.tokens, r.sessions, r.workMs])).toEqual([
      ['app', 130, 2, 3_600_000 + 60_000],
      ['none', 50, 1, 0],
      ['outside', 7, 1, 0],
    ]);
    expect(stats.byProfile.map((r) => [r.label, r.tokens])).toEqual([
      ['個人', 157],
      ['チーム', 30],
    ]);
    expect(stats.daily).toHaveLength(7);
    expect(stats.daily.reduce((a, d) => a + d.tokens, 0)).toBe(187);
    expect(stats.totalTokens).toBe(187);
  });
});

describe('startTask with a real session (fake claude)', () => {
  const fake = path.resolve(
    __dirname,
    '..',
    '..',
    'e2e',
    'fixtures',
    process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh',
  );
  let db: Db;
  let svc: CodeDeckService;
  beforeEach(() => {
    process.env.CODEDECK_CLAUDE_PATH = fake;
    if (process.platform !== 'win32') fs.chmodSync(fake, 0o755);
    tmp = mk('start');
    db = openDatabase(path.join(tmp, 'db'));
    svc = new CodeDeckService({
      db,
      settings: new SettingsStore(path.join(tmp, 's.json')),
      stateDir: tmp,
      home: tmp,
      ptyEvents: { onData: () => {}, onState: () => {} },
      onChange: () => {},
    });
  });
  afterEach(() => {
    svc.shutdown();
    db.close();
    delete process.env.CODEDECK_CLAUDE_PATH;
    rm(tmp);
  });

  it('opens a session with the pinned profile, types the task, marks it in progress, logs work time', async () => {
    const team = svc.createProfile({ name: 'team', kind: 'team' });
    const pr = svc.createProject({ name: 'app', path: tmp, pinnedProfileId: team.id });
    const task = svc.createTask(pr.id, 'Fix login error', 'details here');
    const s = await svc.startTask(task.id);
    expect(s.profileId).toBe(team.id);
    expect(svc.tasks.get(task.id)).toMatchObject({ status: 'doing', sessionId: s.id });
    const until = async (fn: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 100));
    };
    await until(async () => (await svc.screens.lines(s.id, 40)).join('\n').includes('FAKE-CLAUDE done'));
    expect((await svc.screens.lines(s.id, 40)).join('\n')).toContain('Fix login error');
    await until(() => svc.workSpans(0).length > 0);
    expect(svc.workSpans(0)[0]).toMatchObject({ sessionId: s.id });
  }, 60_000);
});
