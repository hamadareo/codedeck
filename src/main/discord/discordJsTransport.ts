import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle as DjsButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import type {
  ButtonStyle,
  CommandDef,
  CommandName,
  DiscordTransport,
  OutMessage,
  OutModal,
  OutRow,
  Reply,
  TransportHandlers,
} from './transport';

const STYLE: Record<ButtonStyle, DjsButtonStyle> = {
  primary: DjsButtonStyle.Primary,
  secondary: DjsButtonStyle.Secondary,
  success: DjsButtonStyle.Success,
  danger: DjsButtonStyle.Danger,
};

function toRow(row: OutRow): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const r = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if ('select' in row)
    return r.addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(row.select.id)
        .setPlaceholder(row.select.placeholder.slice(0, 150))
        .addOptions(
          row.select.options.slice(0, 25).map((o) => ({
            label: o.label.slice(0, 100),
            value: o.value.slice(0, 100),
            description: o.description?.slice(0, 100) || undefined,
          })),
        ),
    );
  return r.addComponents(
    row.buttons
      .slice(0, 5)
      .map((b) =>
        new ButtonBuilder().setCustomId(b.id).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style]),
      ),
  );
}

function toPayload(msg: OutMessage): MessageCreateOptions {
  const mention = msg.mentionUserId ? `<@${msg.mentionUserId}> ` : '';
  const rows: OutRow[] = [
    ...(msg.buttons?.length ? [{ buttons: msg.buttons }] : []),
    ...(msg.rows ?? []).filter((r) => ('select' in r ? r.select.options.length > 0 : r.buttons.length > 0)),
  ];
  const card = msg.card;
  return {
    content: `${mention}${msg.content}`.slice(0, 2000),
    // Only the one user we chose may be pinged: never @everyone, roles, or names in the output.
    allowedMentions: { parse: [], users: msg.mentionUserId ? [msg.mentionUserId] : [] },
    embeds: card
      ? [
          new EmbedBuilder({
            title: card.title.slice(0, 256),
            description: card.description?.slice(0, 4096) || undefined,
            color: card.color,
            footer: card.footer ? { text: card.footer.slice(0, 2048) } : undefined,
          }),
        ]
      : [],
    files: msg.files?.map((f) => new AttachmentBuilder(Buffer.from(f.data, 'utf8'), { name: f.name })),
    components: rows.slice(0, 5).map(toRow),
  };
}

function toModal(m: OutModal): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(m.id)
    .setTitle(m.title.slice(0, 45))
    .addComponents(
      m.inputs.slice(0, 5).map((f) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(f.id)
            .setLabel(f.label.slice(0, 45))
            .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(f.required ?? true)
            .setMaxLength(4000)
            .setPlaceholder(f.placeholder?.slice(0, 100) ?? ''),
        ),
      ),
    );
}

type Answerable = Extract<Interaction, { reply: unknown }>;

/** Answer an interaction: first reply (or update of the clicked message), then follow-ups. */
function replier(i: Answerable, canUpdate: boolean): Reply {
  return async (m) => {
    const base = toPayload(m);
    if (m.update && canUpdate && !i.replied && !i.deferred && 'update' in i) {
      await (i.update as (p: unknown) => Promise<unknown>)(base);
      return;
    }
    const payload = { ...base, flags: m.ephemeral ? MessageFlags.Ephemeral : undefined };
    if (!i.replied && !i.deferred) await i.reply(payload as never);
    else await i.followUp(payload as never);
  };
}

/**
 * discord.js (gateway) transport. The bot needs no privileged intents: it only
 * receives slash commands, button presses, menu choices and forms (interactions),
 * never reads messages.
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
        await h.command({
          name: i.commandName as CommandName,
          options,
          userId: i.user.id,
          userTag: i.user.tag,
          reply: replier(i, false),
        });
      } else if (i.isButton() || i.isStringSelectMenu()) {
        await h.button({
          customId: i.customId,
          values: i.isStringSelectMenu() ? i.values : undefined,
          userId: i.user.id,
          userTag: i.user.tag,
          reply: replier(i, true),
          showModal: (m) => i.showModal(toModal(m)),
        });
      } else if (i.isModalSubmit()) {
        const fields: Record<string, string> = {};
        for (const f of i.fields.fields.values()) if ('value' in f) fields[f.customId] = String(f.value);
        await h.modal({
          customId: i.customId,
          fields,
          userId: i.user.id,
          userTag: i.user.tag,
          reply: replier(i, false),
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
