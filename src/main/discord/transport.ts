/**
 * What the bridge needs from Discord, independent of the library. The
 * discord.js implementation lives in discordJsTransport.ts; tests use a fake.
 */

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface OutButton {
  id: string;
  label: string;
  style: ButtonStyle;
}

export interface OutMessage {
  content: string;
  files?: { name: string; data: string }[];
  buttons?: OutButton[];
  /** Ping this user (only this one; @everyone and roles are never pinged). */
  mentionUserId?: string;
}

export type Reply = (msg: OutMessage & { ephemeral?: boolean }) => Promise<void>;

export type CommandName = 'sessions' | 'new' | 'send' | 'status' | 'stop' | 'usage';

export interface CommandEvent {
  name: CommandName;
  options: Record<string, string>;
  userId: string;
  userTag: string;
  reply: Reply;
}

export interface ButtonEvent {
  customId: string;
  userId: string;
  userTag: string;
  reply: Reply;
}

export interface AutocompleteEvent {
  name: CommandName;
  option: string;
  value: string;
  userId: string;
  respond(choices: { name: string; value: string }[]): Promise<void>;
}

export interface CommandOption {
  name: string;
  description: string;
  required: boolean;
  autocomplete?: boolean;
  /** Long text (instructions). */
  long?: boolean;
}

export interface CommandDef {
  name: CommandName;
  description: string;
  options: CommandOption[];
}

export interface TransportHandlers {
  command(e: CommandEvent): Promise<void>;
  button(e: ButtonEvent): Promise<void>;
  autocomplete(e: AutocompleteEvent): Promise<void>;
}

/** Used by E2E runs: behaves like a Discord that cannot be reached. */
export class OfflineTransport implements DiscordTransport {
  async connect(): Promise<{ botTag: string }> {
    throw new Error('offline (test mode)');
  }
  async disconnect(): Promise<void> {}
  async registerCommands(): Promise<void> {}
  async createThread(): Promise<string> {
    throw new Error('offline (test mode)');
  }
  async send(): Promise<void> {
    throw new Error('offline (test mode)');
  }
}

export interface DiscordTransport {
  connect(token: string, handlers: TransportHandlers): Promise<{ botTag: string }>;
  disconnect(): Promise<void>;
  /** Guild commands appear immediately (global ones can take an hour). */
  registerCommands(guildId: string, defs: CommandDef[]): Promise<void>;
  createThread(channelId: string, name: string): Promise<string>;
  /** Throws when the channel/thread is gone (the bridge then makes a new thread). */
  send(channelId: string, msg: OutMessage): Promise<void>;
}
