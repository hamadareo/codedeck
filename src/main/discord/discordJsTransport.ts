import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle as DjsButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type MessageCreateOptions,
} from 'discord.js';
import type {
  ButtonStyle,
  CommandDef,
  CommandName,
  DiscordTransport,
  OutMessage,
  TransportHandlers,
} from './transport';

const STYLE: Record<ButtonStyle, DjsButtonStyle> = {
  primary: DjsButtonStyle.Primary,
  secondary: DjsButtonStyle.Secondary,
  success: DjsButtonStyle.Success,
  danger: DjsButtonStyle.Danger,
};

function toPayload(msg: OutMessage): MessageCreateOptions {
  const mention = msg.mentionUserId ? `<@${msg.mentionUserId}> ` : '';
  return {
    content: `${mention}${msg.content}`.slice(0, 2000),
    // Only the one user we chose may be pinged: never @everyone, roles, or names in the output.
    allowedMentions: { parse: [], users: msg.mentionUserId ? [msg.mentionUserId] : [] },
    files: msg.files?.map((f) => new AttachmentBuilder(Buffer.from(f.data, 'utf8'), { name: f.name })),
    components: msg.buttons?.length
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            msg.buttons
              .slice(0, 5)
              .map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(STYLE[b.style])),
          ),
        ]
      : [],
  };
}

/**
 * discord.js (gateway) transport. The bot needs no privileged intents: it only
 * receives slash commands and button presses (interactions), never reads messages.
 */
export class DiscordJsTransport implements DiscordTransport {
  private client: Client | null = null;
  private token = '';

  async connect(token: string, handlers: TransportHandlers): Promise<{ botTag: string }> {
    await this.disconnect();
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.on(Events.InteractionCreate, (i) => void this.dispatch(i, handlers));
    await new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve());
      client.login(token).catch(reject);
    });
    this.client = client;
    this.token = token;
    return { botTag: client.user?.tag ?? 'bot' };
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.token = '';
    if (c) await c.destroy();
  }

  async registerCommands(guildId: string, defs: CommandDef[]): Promise<void> {
    const appId = this.client?.application?.id;
    if (!appId || !this.token) throw new Error('not connected');
    const body = defs.map((d) => {
      const b = new SlashCommandBuilder().setName(d.name).setDescription(d.description.slice(0, 100));
      for (const o of d.options)
        b.addStringOption((opt) =>
          opt
            .setName(o.name)
            .setDescription(o.description.slice(0, 100))
            .setRequired(o.required)
            .setAutocomplete(!!o.autocomplete)
            .setMaxLength(o.long ? 4000 : 100),
        );
      return b.toJSON();
    });
    await new REST().setToken(this.token).put(Routes.applicationGuildCommands(appId, guildId), { body });
  }

  async createThread(channelId: string, name: string): Promise<string> {
    const ch = await this.client?.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) throw new Error('channel is not a text channel');
    const thread = await ch.threads.create({ name, autoArchiveDuration: 1440 });
    return thread.id;
  }

  async send(channelId: string, msg: OutMessage): Promise<void> {
    const ch = await this.client?.channels.fetch(channelId);
    if (!ch || !ch.isSendable()) throw new Error('channel not available');
    await ch.send(toPayload(msg));
  }

  private async dispatch(i: Interaction, h: TransportHandlers): Promise<void> {
    try {
      if (i.isChatInputCommand()) {
        const options: Record<string, string> = {};
        for (const o of i.options.data) if (typeof o.value === 'string') options[o.name] = o.value;
        // Defer first: Discord needs an answer within 3 s; the work may take longer.
        let deferred = false;
        await h.command({
          name: i.commandName as CommandName,
          options,
          userId: i.user.id,
          userTag: i.user.tag,
          reply: async (m) => {
            const payload = {
              ...toPayload(m),
              ephemeral: undefined,
              flags: m.ephemeral ? 1 << 6 : undefined,
            };
            if (!deferred && !i.replied) {
              deferred = true;
              await i.reply(payload as never);
            } else await i.followUp(payload as never);
          },
        });
      } else if (i.isButton()) {
        await h.button({
          customId: i.customId,
          userId: i.user.id,
          userTag: i.user.tag,
          reply: async (m) => {
            const payload = { ...toPayload(m), flags: m.ephemeral ? 1 << 6 : undefined };
            if (!i.replied) await i.reply(payload as never);
            else await i.followUp(payload as never);
          },
        });
      } else if (i.isAutocomplete()) {
        const focused = i.options.getFocused(true);
        await h.autocomplete({
          name: i.commandName as CommandName,
          option: focused.name,
          value: String(focused.value ?? ''),
          userId: i.user.id,
          respond: (choices) => i.respond(choices),
        });
      }
    } catch {
      // A failed reply must not take the bot down; the user sees Discord's own "interaction failed".
    }
  }
}
