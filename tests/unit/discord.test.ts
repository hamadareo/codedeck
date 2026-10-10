import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  codeMessage,
  DEFAULT_DISCORD,
  findDanger,
  approvalRegion,
  maskSecrets,
  matchSession,
  normalizeDiscord,
  parseIdList,
  tidyScreen,
  type DiscordSettings,
} from '@shared/discord';
import { displayStatus } from '@shared/status';
import { openDatabase, type Db } from '../../src/main/db/database';
import { CodeDeckService } from '../../src/main/service';
import { SettingsStore } from '../../src/main/settings';
import { DiscordBridge, type RemoteKind } from '../../src/main/discord/bridge';
import { parseShortstat, ThreadRepo } from '../../src/main/discord/controller';
import { SecretStore, type Cipher } from '../../src/main/discord/secretStore';
import { removeDir } from './cleanup';
import type {
  ButtonEvent,
  CommandDef,
  CommandEvent,
  CommandName,
  DiscordTransport,
  ModalEvent,
  OutMessage,
  OutModal,
  TransportHandlers,
} from '../../src/main/discord/transport';

describe('safety rules', () => {
  it('masks keys, tokens and .env secrets; keeps ordinary text', () => {
    const input = [
      'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
      'export GITHUB_TOKEN="ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'password: hunter2hunter2',
      'aws AKIAABCDEFGHIJKLMNOP',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
      'normal line with key words but no secret',
    ].join('\n');
    const { text, masked } = maskSecrets(input);
    expect(text).not.toMatch(/sk-ant|ghp_|hunter2|AKIA|MIIabc/);
    expect(text).toContain('ANTHROPIC_API_KEY=••••••');
    expect(text).toContain('normal line with key words but no secret');
    expect(masked).toBeGreaterThanOrEqual(5);
  });

  it('flags dangerous operations (Japanese too) but not ordinary requests', () => {
    expect(findDanger('please run git push origin main')).toEqual(['git push']);
    expect(findDanger('rm -rf build && git reset --hard')).toEqual(['rm -r', 'git reset --hard']);
    expect(findDanger('Remove-Item .\\dist -Recurse -Force')).toContain('Remove-Item -Recurse');
    expect(findDanger('古いファイルを全部削除して')).toEqual(['削除']);
    expect(findDanger('テストを追加して、型エラーを直して')).toEqual([]);
  });

  it('long output becomes an attachment; code fences cannot be broken out of', () => {
    const short = codeMessage('h', 'line ``` x');
    expect(short.file).toBeNull();
    expect(short.content.match(/```/g)).toHaveLength(2);
    const long = codeMessage('h', 'x'.repeat(5000));
    expect(long.file?.name).toBe('output.txt');
    expect(long.content.length).toBeLessThanOrEqual(2000);
  });

  it('settings: only snowflake ids survive; defaults keep /new and /stop off', () => {
    expect(parseIdList('123, 12345678901234567, abc 98765432109876543210')).toEqual([
      '12345678901234567',
      '98765432109876543210',
    ]);
    const s = normalizeDiscord({ guildId: 'x', permissions: { send: false } as never });
    expect(s.guildId).toBe('');
    expect(s.permissions).toEqual({ send: false, approve: true, newSession: false, stop: false });
    expect(DEFAULT_DISCORD.permissions.newSession).toBe(false);
  });

  it('approval region: only what follows the last input line counts', () => {
    const screen = [
      '> git push --force',
      'done',
      '> run the tests',
      '● Bash(npm test)',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ];
    expect(findDanger(approvalRegion(screen))).toEqual([]);
    expect(
      findDanger(approvalRegion([...screen.slice(0, 3), '● Bash(git push origin main)', '❯ 1. Yes'])),
    ).toEqual(['git push']);
  });

  it('session matching and screen tidying', () => {
    const ss = [
      { id: 'aaa111', title: 'app #1' },
      { id: 'bbb222', title: 'app #2' },
    ];
    expect(matchSession(ss, 'app #2')?.id).toBe('bbb222');
    expect(matchSession(ss, 'app')).toBeNull(); // ambiguous
    expect(matchSession(ss, 'aaa')?.id).toBe('aaa111');
    expect(tidyScreen(['a', '', '', '────────────', 'b', '', ''])).toBe('a\n\nb');
  });

  it('git shortstat', () => {
    expect(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({
      files: 3,
      insertions: 10,
      deletions: 2,
    });
    expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseShortstat('fatal: not a git repository')).toBeNull();
  });

  it('the token is stored encrypted, never in plain text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd secret '));
    const cipher: Cipher = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
      decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
    };
    const store = new SecretStore(dir, cipher);
    store.set('MTIz.secret-token-value');
    const raw = fs.readFileSync(path.join(dir, 'discord-token.bin'));
    expect(raw.toString()).not.toContain('secret-token-value');
    expect(store.get()).toBe('MTIz.secret-token-value');
    store.clear();
    expect(store.has()).toBe(false);
    const noKeychain = new SecretStore(dir, { ...cipher, isEncryptionAvailable: () => false });
    expect(() => noKeychain.set('x')).toThrow('discord.error.noKeychain');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- the bridge against the real session service and a fake claude ----------

class FakeTransport implements DiscordTransport {
  handlers: TransportHandlers | null = null;
  registered: { guildId: string; defs: CommandDef[] } | null = null;
  posts: { channel: string; msg: OutMessage }[] = [];
  threads = 0;
  async connect(_token: string, h: TransportHandlers) {
    this.handlers = h;
    return { botTag: 'CodeDeckBot#0001' };
  }
  async disconnect() {}
  async registerCommands(guildId: string, defs: CommandDef[]) {
    this.registered = { guildId, defs };
  }
  async createThread() {
    return `thread-${++this.threads}`;
  }
  async send(channel: string, msg: OutMessage) {
    this.posts.push({ channel, msg });
  }
}

const OWNER = '11111111111111111';
const STRANGER = '22222222222222222';
const fakeClaude = path.resolve(
  __dirname,
  '..',
  '..',
  'e2e',
  'fixtures',
  process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh',
);

// Real PTYs and hook shells: allow for slow CI machines and parallel suites.
describe('DiscordBridge with real sessions', { timeout: 30_000 }, () => {
  let tmp = '';
  let db: Db;
  let svc: CodeDeckService;
  let bridge: DiscordBridge;
  let transport: FakeTransport;
  const logs: string[] = [];
  const remote: { kind: RemoteKind; preview: string }[] = [];
  let settings: DiscordSettings;
  let sessionId = '';

  const until = async (fn: () => boolean | Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out');
  };
  const screen = async () => (await svc.screens.lines(sessionId, 60)).join('\n');

  async function command(name: CommandName, options: Record<string, string>, userId = OWNER) {
    const replies: (OutMessage & { ephemeral?: boolean })[] = [];
    const e: CommandEvent = {
      name,
      options,
      userId,
      userTag: 'owner',
      reply: async (m) => void replies.push(m),
    };
    await transport.handlers!.command(e);
    return replies;
  }
  async function press(customId: string, userId = OWNER, values?: string[]) {
    const replies: (OutMessage & { ephemeral?: boolean; update?: boolean })[] = [];
    const modals: OutModal[] = [];
    const e: ButtonEvent = {
      customId,
      values,
      userId,
      userTag: 'owner',
      reply: async (m) => void replies.push(m),
      showModal: async (m) => void modals.push(m),
    };
    await transport.handlers!.button(e);
    return Object.assign(replies, { modals });
  }
  async function submit(customId: string, fields: Record<string, string>, userId = OWNER) {
    const replies: (OutMessage & { ephemeral?: boolean })[] = [];
    const e: ModalEvent = {
      customId,
      fields,
      userId,
      userTag: 'owner',
      reply: async (m) => void replies.push(m),
    };
    await transport.handlers!.modal(e);
    return replies;
  }
  const buttonsOf = (m: OutMessage) => (m.rows ?? []).flatMap((r) => ('buttons' in r ? r.buttons : []));
  const selectOf = (m: OutMessage) => (m.rows ?? []).flatMap((r) => ('select' in r ? [r.select] : []))[0]!;

  beforeAll(async () => {
    process.env.CODEDECK_CLAUDE_PATH = fakeClaude;
    if (process.platform !== 'win32') fs.chmodSync(fakeClaude, 0o755);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd bridge テスト '));
    db = openDatabase(path.join(tmp, 'db.sqlite'));
    let bridgeRef: DiscordBridge | null = null;
    svc = new CodeDeckService({
      db,
      settings: new SettingsStore(path.join(tmp, 'settings.json')),
      stateDir: tmp,
      home: tmp,
      ptyEvents: { onData: () => {}, onState: () => {} },
      onChange: () => {},
      onActivity: (id, a, prev) => bridgeRef?.onActivity(id, a, prev),
    });
    settings = {
      ...DEFAULT_DISCORD,
      enabled: true,
      guildId: '33333333333333333',
      channelId: '44444444444444444',
      allowedUserIds: [OWNER],
      mentionAfterSec: 0,
    };
    transport = new FakeTransport();
    bridge = new DiscordBridge(transport, {
      settings: () => settings,
      locale: () => 'ja',
      sessions: () => svc.sessions.list(),
      profiles: () => svc.profiles.list(),
      projects: () => svc.projects.list(),
      homeDir: () => tmp,
      statusOf: (id) => {
        const s = svc.sessions.get(id);
        return s ? displayStatus(s, svc.ptys.state(id), svc.activity(id)) : 'idle';
      },
      isRunning: (id) => svc.ptys.isRunning(id),
      screenLines: (id, max) => svc.screens.lines(id, max),
      createSession: (input) => svc.createSession(input),
      startPty: (id) => svc.startPty(id, 100, 30),
      submitText: (id, text) => svc.submitText(id, text),
      input: (id, data) => svc.input(id, data),
      usage: () => [],
      diffSummary: async () => ({ files: 2, insertions: 5, deletions: 1 }),
      threads: new ThreadRepo(db),
      log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      onRemoteInput: (_id, _u, kind, preview) => remote.push({ kind, preview }),
      onStatus: () => {},
    });
    bridgeRef = bridge;
    await bridge.start('token');
    const p = svc.createProfile({ name: 'team', kind: 'team' });
    const s = svc.createSession({ profileId: p.id, cwd: tmp, title: 'job' });
    sessionId = s.id;
    svc.startPty(s.id, 100, 30);
    await until(() => svc.activity(s.id) === 'waiting'); // SessionStart hook
  }, 60_000);

  afterAll(async () => {
    await bridge.stop();
    svc.shutdown();
    db.close();
    delete process.env.CODEDECK_CLAUDE_PATH;
    removeDir(tmp);
  });

  it('registers guild commands', () => {
    expect(transport.registered?.guildId).toBe('33333333333333333');
    expect(transport.registered?.defs.map((d) => d.name)).toEqual([
      'panel',
      'sessions',
      'new',
      'send',
      'status',
      'stop',
      'usage',
    ]);
  });

  it('regression: users outside the allow-list are ignored and logged', async () => {
    const replies = await command('send', { session: 'job', text: 'hello from stranger' }, STRANGER);
    expect(replies).toEqual([]);
    expect([...(await press(`cd:allow:${sessionId}`, STRANGER))]).toEqual([]);
    expect(logs.filter((l) => l.startsWith('ignored') && l.includes(STRANGER))).toHaveLength(2);
    expect(await screen()).not.toContain('stranger');
  });

  it('/sessions and /send type into the real session; the app is told it came from Discord', async () => {
    const list = await command('sessions', {});
    expect(list[0]!.content).toMatch(/job.*team.*入力待ち/);
    const r = await command('send', { session: 'job', text: 'hello from phone' });
    expect(r[0]!.content).toContain('送信しました');
    await until(async () => (await screen()).includes('FAKE-CLAUDE saved'));
    expect(remote.at(-1)).toEqual({ kind: 'send', preview: 'hello from phone' });
    // The turn ends: a "done" post with the diff summary and a mention lands in the session's thread.
    await until(() => transport.posts.some((p) => p.msg.content.includes('完了: job')));
    const done = transport.posts.find((p) => p.msg.content.includes('完了: job'))!;
    expect(done.channel).toBe('thread-1');
    expect(done.msg.content).toContain('変更: 2 ファイル、+5 / -1 行');
    expect(done.msg.mentionUserId).toBe(OWNER);
  });

  it('panel: pick a session from the menu, open the instruction form, send — no commands to type', async () => {
    const panel = (await command('panel', {}))[0]!;
    expect(panel.card!.description).toMatch(/job/);
    expect(panel.card!.description).toMatch(/team/);
    expect(selectOf(panel).options[0]!.value).toBe(sessionId);
    expect(buttonsOf(panel).map((b) => b.label)).toEqual(['🔄 更新', '📊 使用量']); // /new is off by default
    // Refresh replaces the panel in place.
    expect((await press('cd:refresh:panel'))[0]!.update).toBe(true);

    const card = (await press('cd:pick:panel', OWNER, [sessionId]))[0]!;
    expect(card.ephemeral).toBe(true);
    expect(card.card!.title).toContain('job');
    expect(card.card!.footer).toBe(`team · ${path.basename(tmp)}`);
    const ask = buttonsOf(card).find((b) => b.id === `cd:ask:${sessionId}`)!;
    expect(ask.label).toBe('💬 指示を送る');

    const opened = await press(ask.id);
    expect(opened.modals[0]!.id).toBe(`cd:askform:${sessionId}`);
    // Not allow-listed: the form is ignored too.
    expect(await submit(opened.modals[0]!.id, { text: 'form from stranger' }, STRANGER)).toEqual([]);
    const sent = await submit(opened.modals[0]!.id, { text: 'hello from form' });
    expect(sent[0]!.content).toContain('送信しました');
    await until(async () => (await screen()).includes('hello from form'));
    expect(await screen()).not.toContain('form from stranger');
    expect(remote.at(-1)).toEqual({ kind: 'send', preview: 'hello from form' });
  });

  it('dangerous instructions need a confirmation by the same user', async () => {
    const r = await command('send', { session: 'job', text: 'git push --force' });
    expect(r[0]!.content).toContain('危険な操作の可能性があります');
    const confirmId = r[0]!.buttons!.find((b) => b.style === 'danger')!.id;
    expect(await screen()).not.toContain('git push');
    // Someone else (even allow-listed later) cannot confirm it.
    settings = { ...settings, allowedUserIds: [OWNER, STRANGER] };
    expect((await press(confirmId, STRANGER))[0]!.content).toContain('期限切れ');
    settings = { ...settings, allowedUserIds: [OWNER] };
    const again = await command('send', { session: 'job', text: 'git push --force' });
    await press(again[0]!.buttons!.find((b) => b.style === 'danger')!.id);
    await until(async () => (await screen()).includes('git push --force'));
  });

  it('approval buttons: a post with Allow / Deny; Allow answers the prompt', async () => {
    await until(() => svc.activity(sessionId) === 'waiting' || svc.activity(sessionId) === 'done');
    // The previous turn has ended on screen too (hooks can lag behind the output on slow machines):
    // "perm" must start a new input line, as a user's would.
    await until(async () => {
      const lines = (await screen()).split('\n').filter((l) => l.trim());
      return lines.at(-1)?.trim() === '>' && !!lines.at(-2)?.includes('FAKE-CLAUDE done');
    });
    await command('send', { session: 'job', text: 'perm' });
    await until(() => svc.activity(sessionId) === 'approval');
    await until(() => transport.posts.some((p) => p.msg.content.includes('承認待ち: job')));
    const post = transport.posts.find((p) => p.msg.content.includes('承認待ち: job'))!;
    expect(buttonsOf(post.msg).map((b) => b.label)).toEqual([
      '✅ 許可',
      '❌ 拒否',
      '💬 指示を送る',
      '🖥️ 画面を見る',
    ]);
    expect(post.msg.card!.title).toContain('承認待ち');
    const allowId = buttonsOf(post.msg)[0]!.id;
    const ok = await press(allowId);
    expect(ok[0]!.content).toContain('許可しました');
    expect(svc.activity(sessionId)).toBe('working');
    expect(remote.at(-1)?.kind).toBe('approve');
    // Pressing again: nothing is waiting any more.
    expect((await press(allowId))[0]!.content).toContain('もう待っていません');
  });

  it('/status masks secrets from the screen', async () => {
    await until(() => svc.activity(sessionId) !== 'working', 10_000).catch(() => {});
    svc.input(sessionId, 'key sk-ant-api03-SUPERSECRETVALUE');
    await until(async () => (await screen()).includes('SUPERSECRET'));
    const r = await command('status', { session: 'job' });
    expect(r[0]!.content).not.toContain('SUPERSECRET');
    expect(r[0]!.content).toContain('••••••');
    expect(r[0]!.content).toMatch(/伏せました/);
    svc.input(sessionId, '\r');
  });

  it('/new and /stop are off by default', async () => {
    expect((await command('new', { profile: 'team' }))[0]!.content).toContain('許可されていません');
    expect((await command('stop', { session: 'job' }))[0]!.content).toContain('許可されていません');
    expect(svc.sessions.list()).toHaveLength(1);
  });

  it('/new when allowed: starts a session with the profile and sends the first prompt', async () => {
    settings = { ...settings, permissions: { ...settings.permissions, newSession: true } };
    const r = await command('new', { profile: 'team', prompt: 'first task' });
    expect(r[0]!.content).toContain('開始しました');
    const created = svc.sessions.list().find((s) => s.id !== sessionId)!;
    await until(async () => (await svc.screens.lines(created.id, 40)).join('\n').includes('first task'));
  });

  it('new session with buttons: pick where it starts from a menu', async () => {
    const before = svc.sessions.list().length;
    const menu = (await press('cd:newmenu:panel'))[0]!;
    const profile = svc.profiles.list()[0]!;
    const choice = selectOf(menu).options.find((o) => o.value === `-|${profile.id}`)!;
    expect(choice.label).toContain('プロジェクトなし');
    const r = (await press('cd:newpick:panel', OWNER, [choice.value]))[0]!;
    expect(r.content).toContain('開始しました');
    expect(buttonsOf(r)[0]!.label).toBe('💬 指示を送る');
    expect(svc.sessions.list()).toHaveLength(before + 1);
  });
});
