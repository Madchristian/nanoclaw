import { Client, Events, GatewayIntentBits, Message, TextChannel, DMChannel, Partials } from 'discord.js';
import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  token: string;
  ownerId: string;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private ownerDmChannelId: string | null = null;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        logger.info({ user: readyClient.user.tag }, 'Connected to Discord');
        resolve();
      });

      this.client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.id === this.client.user?.id) return;
        if (message.author.bot) return;

        const chatJid = `discord:${message.channelId}`;
        const timestamp = message.createdAt.toISOString();

        // Track owner DM channel
        if (message.channel.isDMBased() && message.author.id === this.opts.ownerId) {
          this.ownerDmChannelId = message.channelId;
        }

        const channelName = message.channel.isDMBased()
          ? `DM:${message.author.username}`
          : ('name' in message.channel ? message.channel.name : 'unknown');

        // Store chat name for discovery
        updateChatName(chatJid, channelName);
        this.opts.onChatMetadata(chatJid, timestamp, channelName);

        // Deliver message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          this.opts.onMessage(chatJid, {
            id: message.id,
            chat_jid: chatJid,
            sender: message.author.id,
            sender_name: message.member?.displayName || message.author.displayName || message.author.username,
            content: message.content,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
          });
        }
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Cannot resolve JID to Discord channel');
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn({ channelId }, 'Channel not found or not text-based');
        return;
      }

      const chunks = this.splitMessage(text, 2000);
      for (const chunk of chunks) {
        await (channel as TextChannel | DMChannel).send(chunk);
      }
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('discord:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.client.destroy();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = this.jidToChannelId(jid);
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'sendTyping' in channel) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send typing indicator');
    }
  }

  isMainChannel(jid: string): boolean {
    if (!this.ownerDmChannelId) return false;
    return jid === `discord:${this.ownerDmChannelId}`;
  }

  private jidToChannelId(jid: string): string | null {
    const match = jid.match(/^discord:(\d+)$/);
    return match ? match[1] : null;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) splitAt = maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
