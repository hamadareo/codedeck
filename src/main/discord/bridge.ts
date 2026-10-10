import { randomUUID } from 'node:crypto';
import { translate, type Locale } from '@shared/i18n';
import {
  approvalRegion,
  codeMessage,
  findDanger,
  maskSecrets,
  matchSession,
  threadName,
  tidyScreen,
  type DiscordSettings,
} from '@shared/discord';
import { formatDuration, type ProfileUsage } from '@shared/usage';
import type { NotificationRecord } from '@shared/notify';
import type { Activity, NewSessionInput, Profile, Project, Session, SessionStatus } from '@shared/types';
import type {
  AutocompleteEvent,
  ButtonEvent,
  CommandDef,
  CommandEvent,
  DiscordTransport,
  ModalEvent,
  OutButton,
  OutMessage,
  OutModal,
  OutRow,
  Reply,
} from './transport';

export type RemoteKind = 'send' | 'approve' | 'deny' | 'stop' | 'new';

export interface BridgeDeps {
  settings(): DiscordSettings;
  locale(): Locale;
  sessions(): Session[];
  profiles(): Profile[];
  projects(): Project[];
  homeDir(): string;
  statusOf(id: string): SessionStatus;
  isRunning(id: string): boolean;
  screenLines(id: string, max: number): Promise<string[]>;
  createSession(input: NewSessionInput): Session;
  startPty(id: string): void;
  submitText(id: string, text: string): Promise<void>;
  input(id: string, data: string): void;
  usage(): ProfileUsage[];
  diffSummary(cwd: string): Promise<{ files: number; insertions: number; deletions: number } | null>;
  threads: { get(sessionId: string): string | null; set(sessionId: string, threadId: string): void };
  log(message: string, fields?: Record<string, string | number | boolean | null>): void;
  /** Show "from Discord" in the app (§6: 誤送信防止). */
  onRemoteInput(sessionId: string, userTag: string, kind: RemoteKind, preview: string): void;
  onStatus(status: BridgeStatus): void;
  now?(): number;
}

export type BridgeStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'connected'; botTag: string }
  | { state: 'error'; error: string };

interface Pending {
  action: 'send' | 'allow';
  sessionId: string;
  text?: string;
  userId: string;
  expires: number;
}

const CONFIRM_TTL = 2 * 60_000;
/** Status at a glance: an icon (never color alone) and a card color. */
const STATUS_ICON: Record<SessionStatus, string> = {
  idle: '⚫',
  starting: '⚪',
  running: '⚪',
  working: '🔵',
  waiting: '🟢',
  approval: '🟡',
  done: '✅',
  error: '🔴',
  limit: '⏸️',
  exited: '⚫',
  external: '↗️',
};
const STATUS_COLOR: Record<SessionStatus, number> = {
  idle: 0x64748b,
  starting: 0x94a3b8,
  running: 0x94a3b8,
  working: 0x3b82f6,
  waiting: 0x22c55e,
  approval: 0xf59e0b,
  done: 0x16a34a,
  error: 0xef4444,
  limit: 0xa855f7,
  exited: 0x64748b,
  external: 0x64748b,
};
/** Sessions that need the user come first, then busy ones, then the rest. */
const STATUS_ORDER: SessionStatus[] = ['approval', 'error', 'limit', 'working', 'done', 'waiting'];
const STATUS_LINES = 30;
const MAX_REMINDERS = 3;

/**
 * Discord remote control (§6). Only allow-listed users are served; everything
 * else is ignored and logged. Output leaves the machine only masked, summarized,
 * and in the configured private channel.
 */
export class DiscordBridge {
  private status: BridgeStatus = { state: 'off' };
  private readonly pending = new Map<string, Pending>();
  private readonly workingSince = new Map<string, number>();
  private readonly reminders = new Map<string, NodeJS.Timeout>();
  private readonly progress = new Map<string, NodeJS.Timeout>();
  private readonly lastPosted = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly transport: DiscordTransport,
    private readonly deps: BridgeDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private t(key: string, vars?: Record<string, string | number>): string {
    return translate(this.deps.locale(), key, vars);
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  private setStatus(s: BridgeStatus): void {
    this.status = s;
    this.deps.onStatus(s);
  }

  commandDefs(): CommandDef[] {
    const t = (k: string) => this.t(k);
    const session = { name: 'session', description: t('dc.opt.session'), required: true, autocomplete: true };
    return [
      { name: 'panel', description: t('dc.cmd.panel'), options: [] },
      { name: 'sessions', description: t('dc.cmd.sessions'), options: [] },
      {
        name: 'new',
        description: t('dc.cmd.new'),
        options: [
          { name: 'profile', description: t('dc.opt.profile'), required: true, autocomplete: true },
          { name: 'project', description: t('dc.opt.project'), required: false, autocomplete: true },
          { name: 'prompt', description: t('dc.opt.prompt'), required: false, long: true },
        ],
      },
      {
        name: 'send',
        description: t('dc.cmd.send'),
        options: [session, { name: 'text', description: t('dc.opt.text'), required: true, long: true }],
      },
      { name: 'status', description: t('dc.cmd.status'), options: [{ ...session, required: false }] },
      { name: 'stop', description: t('dc.cmd.stop'), options: [session] },
      { name: 'usage', description: t('dc.cmd.usage'), options: [] },
    ];
  }

  async start(token: string): Promise<void> {
    const s = this.deps.settings();
    this.setStatus({ state: 'connecting' });
    try {
      const { botTag } = await this.transport.connect(token, {
        command: (e) => this.onCommand(e),
        button: (e) => this.onButton(e),
        modal: (e) => this.onModal(e),
        autocomplete: (e) => this.onAutocomplete(e),
      });
      if (s.guildId) await this.transport.registerCommands(s.guildId, this.commandDefs());
      this.setStatus({ state: 'connected', botTag });
      this.deps.log('connected', { bot: botTag });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: 'error', error });
      this.deps.log('connect failed', { error });
      await this.transport.disconnect().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    for (const t of [...this.reminders.values(), ...this.progress.values()]) clearTimeout(t);
    this.reminders.clear();
    this.progress.clear();
    this.pending.clear();
    await this.transport.disconnect().catch(() => {});
    this.setStatus({ state: 'off' });
  }

  private connected(): boolean {
    return this.status.state === 'connected';
  }

  // ---------- security ----------

  /** §6: only allow-listed users; anyone else is ignored and logged (user id only). */
  private allowed(userId: string, what: string): boolean {
    if (this.deps.settings().allowedUserIds.includes(userId)) return true;
    this.deps.log('ignored: user not allowed', { user: userId, what });
    return false;
  }

  // ---------- commands ----------

  async onCommand(e: CommandEvent): Promise<void> {
    if (!this.allowed(e.userId, `/${e.name}`)) return;
    const perms = this.deps.settings().permissions;
    this.deps.log('command', { user: e.userId, command: e.name });
    const forbid = (op: string) => e.reply({ content: this.t('dc.forbidden', { op }), ephemeral: true });
    const open = () => this.deps.sessions().filter((s) => s.open);
    const find = async () => {
      const s = matchSession(open(), e.options.session ?? '');
      if (!s)
        await e.reply({ content: this.t('dc.notFound', { q: e.options.session ?? '' }), ephemeral: true });
      return s;
    };

    switch (e.name) {
      case 'panel':
        return e.reply(this.panelMessage());
      case 'sessions': {
        const list = open();
        const profiles = new Map(this.deps.profiles().map((p) => [p.id, p.name]));
        const lines = list.map(
          (s) =>
            `• **${s.title}** — ${profiles.get(s.profileId) ?? '?'} — ${this.t(`status.${this.deps.statusOf(s.id)}`)}`,
        );
        return e.reply({ content: lines.length ? lines.join('\n') : this.t('dc.noSessions') });
      }
      case 'status': {
        if (!e.options.session) return e.reply(this.panelMessage());
        const s = await find();
        if (!s) return;
        return e.reply(
          await this.screenMessage(
            s,
            this.t('dc.status', { session: s.title, status: this.t(`status.${this.deps.statusOf(s.id)}`) }),
          ),
        );
      }
      case 'usage':
        return e.reply(this.usageMessage());
      case 'stop': {
        if (!perms.stop) return forbid('/stop');
        const s = await find();
        if (!s) return;
        return this.interrupt(s, e.userTag, e.reply);
      }
      case 'send': {
        if (!perms.send) return forbid('/send');
        const s = await find();
        if (!s) return;
        return this.sendFromDiscord(s, e.options.text ?? '', e.userId, e.userTag, e.reply);
      }
      case 'new': {
        if (!perms.newSession) return forbid('/new');
        const profile = this.deps
          .profiles()
          .find((p) => p.name.toLowerCase() === (e.options.profile ?? '').toLowerCase());
        if (!profile)
          return e.reply({
            content: this.t('dc.unknownProfile', { q: e.options.profile ?? '' }),
            ephemeral: true,
          });
        let project: Project | null = null;
        if (e.options.project) {
          project =
            this.deps.projects().find((p) => p.name.toLowerCase() === e.options.project!.toLowerCase()) ??
            null;
          if (!project)
            return e.reply({
              content: this.t('dc.unknownProject', { q: e.options.project }),
              ephemeral: true,
            });
        }
        const prompt = e.options.prompt?.trim() ?? '';
        const danger = prompt ? findDanger(prompt) : [];
        const s = this.deps.createSession({
          profileId: profile.id,
          projectId: project?.id ?? null,
          cwd: project?.path ?? this.deps.homeDir(),
        });
        this.deps.startPty(s.id);
        this.deps.onRemoteInput(s.id, e.userTag, 'new', s.title);
        await e.reply({ content: this.t('dc.started', { session: s.title, profile: profile.name }) });
        if (!prompt) return;
        if (danger.length) {
          await this.post(
            s,
            this.confirm({ action: 'send', sessionId: s.id, text: prompt, userId: e.userId }, danger),
          );
          return;
        }
        await this.waitReady(s.id);
        await this.send(s, prompt, e.userTag);
        return;
      }
    }
  }

  async onAutocomplete(e: AutocompleteEvent): Promise<void> {
    if (!this.deps.settings().allowedUserIds.includes(e.userId)) return e.respond([]);
    const q = e.value.toLowerCase();
    const names =
      e.option === 'session'
        ? this.deps
            .sessions()
            .filter((s) => s.open)
            .map((s) => s.title)
        : e.option === 'profile'
          ? this.deps.profiles().map((p) => p.name)
          : e.option === 'project'
            ? this.deps.projects().map((p) => p.name)
            : [];
    await e.respond(
      names
        .filter((n) => n.toLowerCase().includes(q))
        .slice(0, 25)
        .map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })),
    );
  }

  private usageMessage(): OutMessage {
    const profiles = this.deps.profiles();
    const lines = this.deps.usage().map((u) => {
      const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);
      const reset = u.fiveHour.resetAt
        ? ` (${this.t('usage.resetIn', { time: formatDuration(u.fiveHour.resetAt - this.now(), this.deps.locale()) })})`
        : '';
      return this.t('dc.usageLine', {
        profile: profiles.find((p) => p.id === u.profileId)?.name ?? '?',
        p5: pct(u.fiveHour.percent),
        p7: pct(u.sevenDay.percent),
        reset,
      });
    });
    return { content: lines.join('\n') || this.t('usage.none') };
  }

  private async interrupt(s: Session, userTag: string, reply: Reply): Promise<void> {
    if (!this.deps.isRunning(s.id))
      return reply({ content: this.t('dc.notRunning', { session: s.title }), ephemeral: true });
    this.deps.input(s.id, '\x1b');
    this.deps.onRemoteInput(s.id, userTag, 'stop', 'Esc');
    return reply({ content: this.t('dc.stopped', { session: s.title }) });
  }

  /** /send and the instruction form: dangerous text asks for confirmation first. */
  private async sendFromDiscord(
    s: Session,
    text: string,
    userId: string,
    userTag: string,
    reply: Reply,
  ): Promise<void> {
    if (!text.trim()) return;
    if (!this.deps.isRunning(s.id))
      return reply({ content: this.t('dc.notRunning', { session: s.title }), ephemeral: true });
    const danger = findDanger(text);
    if (danger.length) return reply(this.confirm({ action: 'send', sessionId: s.id, text, userId }, danger));
    await this.send(s, text, userTag);
    return reply({ content: this.t('dc.sent', { session: s.title }) });
  }

  // ---------- control panel and session cards: buttons instead of typing ----------

  private statusText(s: Session): string {
    const st = this.deps.statusOf(s.id);
    return `${STATUS_ICON[st]} ${this.t(`status.${st}`)}`;
  }

  /** "profile · project" (the folder name when the session has no project). */
  private where(s: Session): string {
    const profile = this.deps.profiles().find((p) => p.id === s.profileId)?.name ?? '?';
    const project = s.projectId ? this.deps.projects().find((p) => p.id === s.projectId)?.name : null;
    const folder = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd;
    return `${profile} · ${project ?? folder}`;
  }

  private sorted(): Session[] {
    const rank = (s: Session) => {
      const i = STATUS_ORDER.indexOf(this.deps.statusOf(s.id));
      return i < 0 ? STATUS_ORDER.length : i;
    };
    return this.deps
      .sessions()
      .filter((s) => s.open)
      .sort((a, b) => rank(a) - rank(b) || b.lastActiveAt - a.lastActiveAt);
  }

  /** Every session at a glance, a menu to pick one, and the common actions. */
  panelMessage(): OutMessage {
    const list = this.sorted().slice(0, 25);
    const perms = this.deps.settings().permissions;
    const time = new Date(this.now()).toLocaleTimeString(this.deps.locale() === 'ja' ? 'ja-JP' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const rows: OutRow[] = [];
    if (list.length)
      rows.push({
        select: {
          id: 'cd:pick:panel',
          placeholder: this.t('dc.panel.pick'),
          options: list.map((s) => ({
            label: `${STATUS_ICON[this.deps.statusOf(s.id)]} ${s.title}`,
            value: s.id,
            description: `${this.t(`status.${this.deps.statusOf(s.id)}`)} · ${this.where(s)}`,
          })),
        },
      });
    rows.push({
      buttons: [
        { id: 'cd:refresh:panel', label: `🔄 ${this.t('dc.btn.refresh')}`, style: 'secondary' },
        ...(perms.newSession
          ? [{ id: 'cd:newmenu:panel', label: `➕ ${this.t('dc.btn.new')}`, style: 'primary' as const }]
          : []),
        { id: 'cd:usage:panel', label: `📊 ${this.t('dc.btn.usage')}`, style: 'secondary' },
      ],
    });
    return {
      content: '',
      card: {
        title: `🎛️ ${this.t('dc.panel.title')}`,
        description: list.length
          ? list.map((s) => `${this.statusText(s)}\u3000**${s.title}**\n\u3000${this.where(s)}`).join('\n\n')
          : this.t('dc.noSessions'),
        color: 0x5865f2,
        footer: this.t('dc.panel.updated', { time, n: list.length }),
      },
      rows,
    };
  }

  /** The actions that fit the session's state, as buttons. */
  private sessionRows(s: Session): OutRow[] {
    const perms = this.deps.settings().permissions;
    const st = this.deps.statusOf(s.id);
    const rows: OutRow[] = [];
    if (st === 'approval' && perms.approve)
      rows.push({
        buttons: [
          { id: `cd:allow:${s.id}`, label: `✅ ${this.t('dc.btn.allow')}`, style: 'success' },
          { id: `cd:deny:${s.id}`, label: `❌ ${this.t('dc.btn.deny')}`, style: 'danger' },
        ],
      });
    const main: OutButton[] = [];
    if (perms.send && this.deps.isRunning(s.id))
      main.push({ id: `cd:ask:${s.id}`, label: `💬 ${this.t('dc.btn.ask')}`, style: 'primary' });
    main.push({ id: `cd:details:${s.id}`, label: `🖥️ ${this.t('dc.btn.details')}`, style: 'secondary' });
    if (perms.stop && (st === 'working' || st === 'approval'))
      main.push({ id: `cd:stop:${s.id}`, label: `⏹️ ${this.t('dc.btn.stop')}`, style: 'secondary' });
    rows.push({ buttons: main });
    return rows;
  }

  /** A session's screen with a status card and its action buttons. */
  private async sessionCard(s: Session, header: string, lines = STATUS_LINES): Promise<OutMessage> {
    const msg = await this.screenMessage(s, header, lines);
    return {
      ...msg,
      card: {
        title: `${this.statusText(s)}\u3000${s.title}`,
        color: STATUS_COLOR[this.deps.statusOf(s.id)],
        footer: this.where(s),
      },
      rows: this.sessionRows(s),
    };
  }

  /** Choices for a new session: each project with its pinned profile (or every profile), or no project. */
  private newSessionChoices(): { label: string; value: string; description: string }[] {
    const profiles = this.deps.profiles();
    const out: { label: string; value: string; description: string }[] = [];
    const add = (label: string, projectId: string, p: Profile) =>
      out.push({
        label,
        value: `${projectId}|${p.id}`,
        description: this.t('dc.new.with', { profile: p.name }),
      });
    for (const pr of this.deps.projects()) {
      const pinned = profiles.find((p) => p.id === pr.pinnedProfileId);
      for (const p of pinned ? [pinned] : profiles) add(`📁 ${pr.name}`, pr.id, p);
    }
    for (const p of profiles) add(`🏠 ${this.t('dc.new.noProject')}`, '-', p);
    return out.slice(0, 25);
  }

  private askModal(s: Session): OutModal {
    return {
      id: `cd:askform:${s.id}`,
      title: `💬 ${s.title}`,
      inputs: [
        { id: 'text', label: this.t('dc.ask.label'), placeholder: this.t('dc.ask.placeholder'), long: true },
      ],
    };
  }

  async onModal(e: ModalEvent): Promise<void> {
    if (!this.allowed(e.userId, 'form')) return;
    const [prefix, action, ref] = e.customId.split(':');
    if (prefix !== 'cd' || action !== 'askform' || !ref) return;
    this.deps.log('form', { user: e.userId, action });
    if (!this.deps.settings().permissions.send)
      return e.reply({ content: this.t('dc.forbidden', { op: '/send' }), ephemeral: true });
    const s = this.deps.sessions().find((x) => x.id === ref);
    if (!s) return e.reply({ content: this.t('dc.notFound', { q: ref }), ephemeral: true });
    return this.sendFromDiscord(s, e.fields.text ?? '', e.userId, e.userTag, e.reply);
  }

  private async waitReady(id: string, timeoutMs = 30_000): Promise<void> {
    const until = this.now() + timeoutMs;
    while (this.now() < until) {
      const st = this.deps.statusOf(id);
      if (st === 'waiting' || st === 'done') return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private async send(s: Session, text: string, userTag: string): Promise<void> {
    await this.deps.submitText(s.id, text);
    const preview = maskSecrets(text.replace(/\s+/g, ' ')).text.slice(0, 80);
    this.deps.onRemoteInput(s.id, userTag, 'send', preview);
    this.deps.log('sent', { session: s.id, chars: text.length });
  }

  /** A confirmation step for dangerous operations (§6 追加確認). */
  private confirm(p: Omit<Pending, 'expires'>, labels: string[]): OutMessage {
    const id = randomUUID().slice(0, 8);
    this.pending.set(id, { ...p, expires: this.now() + CONFIRM_TTL });
    return {
      content: this.t('dc.confirmDanger', { labels: labels.join(', ') }),
      buttons: [
        { id: `cd:confirm:${id}`, label: this.t('dc.btn.confirm'), style: 'danger' },
        { id: `cd:cancel:${id}`, label: this.t('dc.btn.cancel'), style: 'secondary' },
      ],
    };
  }

  // ---------- buttons ----------

  async onButton(e: ButtonEvent): Promise<void> {
    if (!this.allowed(e.userId, `button ${e.customId.split(':')[1] ?? ''}`)) return;
    const [prefix, action, ref] = e.customId.split(':');
    if (prefix !== 'cd' || !action || !ref) return;
    const perms = this.deps.settings().permissions;
    this.deps.log('button', { user: e.userId, action });

    // Control panel: refresh in place, pick a session, start one, usage.
    if (action === 'refresh') return e.reply({ ...this.panelMessage(), update: true });
    if (action === 'usage') return e.reply({ ...this.usageMessage(), ephemeral: true });
    if (action === 'pick') {
      const s = this.deps.sessions().find((x) => x.id === e.values?.[0]);
      if (!s) return e.reply({ content: this.t('dc.notFound', { q: e.values?.[0] ?? '' }), ephemeral: true });
      return e.reply({ ...(await this.sessionCard(s, '')), ephemeral: true });
    }
    if (action === 'newmenu' || action === 'newpick') {
      if (!perms.newSession)
        return e.reply({ content: this.t('dc.forbidden', { op: '/new' }), ephemeral: true });
      if (action === 'newmenu')
        return e.reply({
          content: this.t('dc.new.prompt'),
          rows: [
            {
              select: {
                id: 'cd:newpick:panel',
                placeholder: this.t('dc.new.pick'),
                options: this.newSessionChoices(),
              },
            },
          ],
          ephemeral: true,
        });
      const [projectId, profileId] = (e.values?.[0] ?? '').split('|');
      const profile = this.deps.profiles().find((p) => p.id === profileId);
      if (!profile)
        return e.reply({ content: this.t('dc.unknownProfile', { q: profileId ?? '' }), ephemeral: true });
      const project = this.deps.projects().find((p) => p.id === projectId) ?? null;
      const s = this.deps.createSession({
        profileId: profile.id,
        projectId: project?.id ?? null,
        cwd: project?.path ?? this.deps.homeDir(),
      });
      this.deps.startPty(s.id);
      this.deps.onRemoteInput(s.id, e.userTag, 'new', s.title);
      return e.reply({
        content: this.t('dc.started', { session: s.title, profile: profile.name }),
        rows: perms.send
          ? [{ buttons: [{ id: `cd:ask:${s.id}`, label: `💬 ${this.t('dc.btn.ask')}`, style: 'primary' }] }]
          : [],
      });
    }

    if (action === 'confirm' || action === 'cancel') {
      const p = this.pending.get(ref);
      this.pending.delete(ref);
      if (!p || p.expires < this.now()) return e.reply({ content: this.t('dc.expired'), ephemeral: true });
      if (p.userId !== e.userId) return e.reply({ content: this.t('dc.expired'), ephemeral: true });
      if (action === 'cancel') return e.reply({ content: this.t('dc.cancelled') });
      const s = this.deps.sessions().find((x) => x.id === p.sessionId);
      if (!s || !this.deps.isRunning(s.id))
        return e.reply({ content: this.t('dc.notRunning', { session: s?.title ?? '' }), ephemeral: true });
      if (p.action === 'send') {
        if (!perms.send)
          return e.reply({ content: this.t('dc.forbidden', { op: '/send' }), ephemeral: true });
        await this.waitReady(s.id);
        await this.send(s, p.text ?? '', e.userTag);
        return e.reply({ content: this.t('dc.sent', { session: s.title }) });
      }
      return this.answerApproval(s, true, e, true);
    }

    const s = this.deps.sessions().find((x) => x.id === ref);
    if (!s) return e.reply({ content: this.t('dc.notFound', { q: ref }), ephemeral: true });
    if (action === 'details') return e.reply({ ...(await this.sessionCard(s, '')), ephemeral: true });
    if (action === 'ask') {
      if (!perms.send) return e.reply({ content: this.t('dc.forbidden', { op: '/send' }), ephemeral: true });
      if (!this.deps.isRunning(s.id))
        return e.reply({ content: this.t('dc.notRunning', { session: s.title }), ephemeral: true });
      return e.showModal?.(this.askModal(s));
    }
    if (action === 'stop') {
      if (!perms.stop) return e.reply({ content: this.t('dc.forbidden', { op: '/stop' }), ephemeral: true });
      return this.interrupt(s, e.userTag, e.reply);
    }
    if (action === 'allow' || action === 'deny') {
      if (!perms.approve)
        return e.reply({ content: this.t('dc.forbidden', { op: this.t('dc.btn.allow') }), ephemeral: true });
      return this.answerApproval(s, action === 'allow', e, false);
    }
  }

  private async answerApproval(
    s: Session,
    allow: boolean,
    e: ButtonEvent,
    confirmed: boolean,
  ): Promise<void> {
    if (this.deps.statusOf(s.id) !== 'approval')
      return e.reply({ content: this.t('dc.approvalStale'), ephemeral: true });
    if (allow && !confirmed) {
      const danger = findDanger(approvalRegion(await this.deps.screenLines(s.id, STATUS_LINES)));
      if (danger.length)
        return e.reply(this.confirm({ action: 'allow', sessionId: s.id, userId: e.userId }, danger));
    }
    // The permission menu has "Yes" selected first: Enter allows, Esc declines.
    this.deps.input(s.id, allow ? '\r' : '\x1b');
    this.clearReminder(s.id);
    this.deps.onRemoteInput(s.id, e.userTag, allow ? 'approve' : 'deny', '');
    return e.reply({ content: this.t(allow ? 'dc.allowed' : 'dc.denied', { user: e.userTag }) });
  }

  // ---------- session events → threads ----------

  onActivity(sessionId: string, activity: Activity, prev: Activity): void {
    if (activity === 'working' && prev !== 'working') this.workingSince.set(sessionId, this.now());
    if (activity !== 'approval') this.clearReminder(sessionId);
    if (activity !== 'working') this.stopProgress(sessionId);
    if (!this.connected() || !this.deps.settings().channelId) return;
    const s = this.deps.sessions().find((x) => x.id === sessionId);
    if (!s) return;
    if (activity === 'working') this.startProgress(s);
    if (activity === 'approval') {
      void this.postApproval(s, 0);
      this.scheduleReminder(s, 1);
    }
    if (activity === 'done' && prev === 'working') void this.postDone(s);
    if (activity === 'error') void this.postScreen(s, this.t('dc.error', { session: s.title }));
    if (activity === 'limit') void this.postScreen(s, this.t('dc.limit', { session: s.title }));
  }

  private async postApproval(s: Session, minutes: number): Promise<void> {
    const header = minutes
      ? this.t('dc.approvalReminder', { session: s.title, min: minutes })
      : this.t('dc.approval', { session: s.title });
    const msg = await this.sessionCard(s, header, 18);
    await this.post(s, { ...msg, mentionUserId: minutes ? this.mentionUser() : undefined });
  }

  private scheduleReminder(s: Session, n: number): void {
    this.clearReminder(s.id);
    if (n > MAX_REMINDERS) return;
    const min = this.deps.settings().approvalReminderMin;
    const timer = setTimeout(() => {
      this.reminders.delete(s.id);
      if (this.deps.statusOf(s.id) !== 'approval' || !this.connected()) return;
      void this.postApproval(s, min * n);
      this.scheduleReminder(s, n + 1);
    }, min * 60_000);
    timer.unref?.();
    this.reminders.set(s.id, timer);
  }

  private clearReminder(id: string): void {
    const t = this.reminders.get(id);
    if (t) clearTimeout(t);
    this.reminders.delete(id);
  }

  private startProgress(s: Session): void {
    this.stopProgress(s.id);
    const every = this.deps.settings().progressEverySec * 1000;
    const tick = () => {
      if (this.deps.statusOf(s.id) !== 'working' || !this.connected()) return this.stopProgress(s.id);
      void this.postScreen(s, this.t('dc.progress', { session: s.title }), true);
      const next = setTimeout(tick, every);
      next.unref?.();
      this.progress.set(s.id, next);
    };
    const first = setTimeout(tick, every);
    first.unref?.();
    this.progress.set(s.id, first);
  }

  private stopProgress(id: string): void {
    const t = this.progress.get(id);
    if (t) clearTimeout(t);
    this.progress.delete(id);
  }

  private async postDone(s: Session): Promise<void> {
    const since = this.workingSince.get(s.id);
    this.workingSince.delete(s.id);
    const ms = since ? this.now() - since : 0;
    const settings = this.deps.settings();
    let header = this.t('dc.done', { session: s.title, duration: formatDuration(ms, this.deps.locale()) });
    const diff = await this.deps.diffSummary(s.cwd).catch(() => null);
    if (diff)
      header += `\n${this.t('dc.diff', { files: diff.files, ins: diff.insertions, del: diff.deletions })}`;
    const msg = await this.sessionCard(s, header, 20);
    const long = ms >= settings.mentionAfterSec * 1000;
    await this.post(s, { ...msg, mentionUserId: long ? this.mentionUser() : undefined });
  }

  private mentionUser(): string | undefined {
    const s = this.deps.settings();
    return s.mentionUserId || s.allowedUserIds[0] || undefined;
  }

  private async postScreen(s: Session, header: string, skipIfUnchanged = false): Promise<void> {
    const msg = await this.sessionCard(s, header, 20);
    if (skipIfUnchanged) {
      const body = msg.content.slice(header.length);
      if (this.lastPosted.get(s.id) === body) return;
      this.lastPosted.set(s.id, body);
    }
    await this.post(s, msg);
  }

  /** Recent screen text, masked; long text becomes an attachment. */
  private async screenMessage(s: Session, header: string, lines = STATUS_LINES): Promise<OutMessage> {
    const text = tidyScreen(await this.deps.screenLines(s.id, 120), lines);
    const m = codeMessage(header, text);
    const note = m.masked ? `\n${this.t('dc.masked', { n: m.masked })}` : '';
    return { content: `${m.content}${note}`.slice(0, 2000), files: m.file ? [m.file] : undefined };
  }

  /** Post into the session's thread (created on first use; recreated if deleted). Serialized per session. */
  private post(s: Session, msg: OutMessage): Promise<void> {
    const prev = this.queues.get(s.id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const channelId = this.deps.settings().channelId;
        if (!channelId || !this.connected()) return;
        let thread = this.deps.threads.get(s.id);
        const profile = this.deps.profiles().find((p) => p.id === s.profileId)?.name ?? '';
        if (!thread) {
          thread = await this.transport.createThread(channelId, threadName(s.title, profile));
          this.deps.threads.set(s.id, thread);
        }
        try {
          await this.transport.send(thread, msg);
        } catch {
          thread = await this.transport.createThread(channelId, threadName(s.title, profile));
          this.deps.threads.set(s.id, thread);
          await this.transport.send(thread, msg);
        }
      })
      .catch((e: unknown) =>
        this.deps.log('post failed', { session: s.id, error: e instanceof Error ? e.message : String(e) }),
      );
    this.queues.set(s.id, next);
    return next;
  }

  // ---------- usage alerts (§7 → Discord) ----------

  onNotification(record: NotificationRecord): void {
    const s = this.deps.settings();
    if (!this.connected() || !s.notifyUsage || !s.channelId) return;
    if (record.kind !== 'usageThreshold' && record.kind !== 'limitReached' && record.kind !== 'usageReset')
      return;
    const icon = record.kind === 'usageReset' ? '✅' : record.kind === 'limitReached' ? '⏸' : '⚠️';
    void this.transport
      .send(s.channelId, {
        content: `${icon} **${record.title}**\n${record.body}`,
        mentionUserId: record.kind === 'usageReset' ? undefined : this.mentionUser(),
      })
      .catch((e: unknown) =>
        this.deps.log('post failed', { error: e instanceof Error ? e.message : String(e) }),
      );
  }
}
