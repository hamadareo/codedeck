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

export interface OutSelect {
  id: string;
  placeholder: string;
  options: { label: string; value: string; description?: string }[];
}

/** One row of controls: up to 5 buttons, or one select menu. */
export type OutRow = { buttons: OutButton[] } | { select: OutSelect };

/** A colored card (a Discord embed). */
export interface OutCard {
  title: string;
  description?: string;
  /** 0xRRGGBB */
  color?: number;
  footer?: string;
}

export interface OutMessage {
  content: string;
  card?: OutCard;
  files?: { name: string; data: string }[];
  /** One row of buttons (shown before `rows`). */
  buttons?: OutButton[];
  rows?: OutRow[];
  /** Ping this user (only this one; @everyone and roles are never pinged). */
  mentionUserId?: string;
}

/** A form that pops up over Discord (a modal): text fields only. */
export interface OutModal {
  id: string;
  title: string;
  inputs: { id: string; label: string; placeholder?: string; long?: boolean; required?: boolean }[];
}

/** `update`: replace the message the button / menu belongs to, instead of answering below it. */
export type Reply = (msg: OutMessage & { ephemeral?: boolean; update?: boolean }) => Promise<void>;

export type CommandName = 'panel' | 'sessions' | 'new' | 'send' | 'status' | 'stop' | 'usage';

export interface CommandEvent {
  name: CommandName;
  options: Record<string, string>;
  userId: string;
  userTag: string;
  reply: Reply;
}

/** A button press, or a choice in a select menu (`values`). */
export interface ButtonEvent {
  customId: string;
  values?: string[];
  userId: string;
  userTag: string;
  reply: Reply;
  /** Open a form instead of replying (only as the first answer). */
  showModal?(modal: OutModal): Promise<void>;
}

export interface ModalEvent {
  customId: string;
  fields: Record<string, string>;
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
  modal(e: ModalEvent): Promise<void>;
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
