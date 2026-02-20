import { Client, Events, GatewayIntentBits, Message, MessageFlags, TextChannel, DMChannel, Partials, AttachmentBuilder } from 'discord.js';
import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  token: string;
  ownerId: string;
  botWhitelist?: string[]; // Bot IDs allowed to send messages (e.g., OpenClaw)
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private ownerDmChannelId: string | null = null;
  private botWhitelist: Set<string>;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.botWhitelist = new Set(opts.botWhitelist || []);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
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
        // Fetch partial messages (DMs often arrive as partials)
        if (message.partial) {
          try {
            await message.fetch();
          } catch (err) {
            logger.warn({ err }, 'Failed to fetch partial message');
            return;
          }
        }

        if (message.author.id === this.client.user?.id) return;
        // Allow messages from whitelisted bots (e.g., OpenClaw), ignore all others
        if (message.author.bot && !this.botWhitelist.has(message.author.id)) return;


        const chatJid = `discord:${message.channelId}`;
        const timestamp = message.createdAt.toISOString();

        // --- DM handling: owner-only pairing ---
        if (message.channel.isDMBased()) {
          // Only the owner may DM the bot
          if (message.author.id !== this.opts.ownerId) {
            logger.info({ sender: message.author.id }, 'Ignoring DM from non-owner');
            return;
          }
          this.ownerDmChannelId = message.channelId;

          // Auto-register owner DM as a group if not already known
          const groups = this.opts.registeredGroups();
          if (!groups[chatJid] && this.opts.registerGroup) {
            logger.info({ chatJid }, 'Owner DM detected — auto-registering as private channel');
            this.opts.registerGroup(chatJid, {
              name: 'Owner DM',
              folder: 'owner-dm',
              trigger: `@${ASSISTANT_NAME}`,
              added_at: new Date().toISOString(),
              requiresTrigger: false,
            });
          }
        }

        const channelName = message.channel.isDMBased()
          ? `DM:${message.author.username}`
          : ('name' in message.channel ? message.channel.name : 'unknown');

        // Store chat name for discovery
        updateChatName(chatJid, channelName);
        this.opts.onChatMetadata(chatJid, timestamp, channelName);

        // Translate @bot mentions into trigger pattern format
        // Discord renders mentions as <@BOT_ID> — replace with @ASSISTANT_NAME
        let content = message.content;
        const botId = this.client.user?.id;
        if (botId && content.includes(`<@${botId}>`)) {
          content = content.replace(new RegExp(`<@${botId}>`, 'g'), `@${ASSISTANT_NAME}`).trim();
        }

        // Append audio/voice attachments as metadata for STT processing
        const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
        const audioAttachments = message.attachments.filter(a =>
          a.contentType?.startsWith('audio/') ||
          a.name?.endsWith('.ogg') ||
          a.name?.endsWith('.mp3') ||
          a.name?.endsWith('.wav') ||
          isVoiceMessage
        );
        if (audioAttachments.size > 0) {
          const urls = audioAttachments.map(a => a.url);
          content = (content ? content + '\n' : '') +
            `[voice_message: ${urls.join(', ')}]`;
        }

        // Deliver message for registered groups
        const currentGroups = this.opts.registeredGroups();
        if (currentGroups[chatJid]) {
          this.opts.onMessage(chatJid, {
            id: message.id,
            chat_jid: chatJid,
            sender: message.author.id,
            sender_name: message.member?.displayName || message.author.displayName || message.author.username,
            content,
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
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.client.destroy();
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    if (!channelId) return;

    // Stop any existing interval for this jid
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const doTyping = async () => {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased() && 'sendTyping' in channel) {
          await (channel as TextChannel | DMChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send typing indicator');
      }
    };

    // Send immediately, then refresh every 8s (Discord typing expires after ~10s)
    await doTyping();
    this.typingIntervals.set(jid, setInterval(doTyping, 8000));
  }

  async sendVoice(jid: string, audioPath: string): Promise<void> {
    const channelId = this.jidToChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Cannot resolve JID to Discord channel for voice');
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn({ channelId }, 'Channel not found or not text-based');
        return;
      }

      const fs = await import('fs');
      if (!fs.existsSync(audioPath)) {
        logger.warn({ audioPath }, 'Audio file not found');
        return;
      }

      const attachment = new AttachmentBuilder(audioPath, {
        name: 'voice-message.mp3',
        description: 'Voice message',
      });

      // Discord voice messages need specific flags — send as regular attachment
      await (channel as TextChannel | DMChannel).send({ files: [attachment] });
      // Clean up the audio file after successful send
      try { fs.unlinkSync(audioPath); } catch { /* already gone */ }
      logger.info({ jid, audioPath }, 'Voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send voice message');
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
