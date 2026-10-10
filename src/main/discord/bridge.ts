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
  OutMessage,
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
      { name: 'status', description: t('dc.cmd.status'), options: [session] },
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
        const s = await find();
        if (!s) return;
        return e.reply(
          await this.screenMessage(
            s,
            this.t('dc.status', { session: s.title, status: this.t(`status.${this.deps.statusOf(s.id)}`) }),
          ),
        );
      }
      case 'usage': {
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
        return e.reply({ content: lines.join('\n') || this.t('usage.none') });
      }
      case 'stop': {
        if (!perms.stop) return forbid('/stop');
        const s = await find();
        if (!s) return;
        if (!this.deps.isRunning(s.id))
          return e.reply({ content: this.t('dc.notRunning', { session: s.title }), ephemeral: true });
        this.deps.input(s.id, '\x1b');
        this.deps.onRemoteInput(s.id, e.userTag, 'stop', 'Esc');
        return e.reply({ content: this.t('dc.stopped', { session: s.title }) });
      }
      case 'send': {
        if (!perms.send) return forbid('/send');
        const s = await find();
        if (!s) return;
        const text = e.options.text ?? '';
        if (!text.trim()) return;
        if (!this.deps.isRunning(s.id))
          return e.reply({ content: this.t('dc.notRunning', { session: s.title }), ephemeral: true });
        const danger = findDanger(text);
        if (danger.length)
          return e.reply(this.confirm({ action: 'send', sessionId: s.id, text, userId: e.userId }, danger));
        await this.send(s, text, e.userTag);
        return e.reply({ content: this.t('dc.sent', { session: s.title }) });
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
    if (action === 'details') return e.reply({ ...(await this.screenMessage(s, s.title)), ephemeral: true });
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
    const msg = await this.screenMessage(s, header, 18);
    const perms = this.deps.settings().permissions;
    await this.post(s, {
      ...msg,
      mentionUserId: minutes ? this.mentionUser() : undefined,
      buttons: [
        ...(perms.approve
          ? [
              { id: `cd:allow:${s.id}`, label: this.t('dc.btn.allow'), style: 'success' as const },
              { id: `cd:deny:${s.id}`, label: this.t('dc.btn.deny'), style: 'danger' as const },
            ]
          : []),
        { id: `cd:details:${s.id}`, label: this.t('dc.btn.details'), style: 'secondary' as const },
      ],
    });
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
    const msg = await this.screenMessage(s, header, 20);
    const long = ms >= settings.mentionAfterSec * 1000;
    await this.post(s, { ...msg, mentionUserId: long ? this.mentionUser() : undefined });
  }

  private mentionUser(): string | undefined {
    const s = this.deps.settings();
    return s.mentionUserId || s.allowedUserIds[0] || undefined;
  }

  private async postScreen(s: Session, header: string, skipIfUnchanged = false): Promise<void> {
    const msg = await this.screenMessage(s, header, 20);
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
