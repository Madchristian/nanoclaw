# /add-discord — Add Discord as a channel

Add Discord as a messaging channel to NanoClaw. Can replace WhatsApp or run alongside it.

## Overview

This skill transforms a NanoClaw installation to support Discord using [discord.js](https://discord.js.org). It follows the existing `Channel` interface pattern from `src/types.ts` and integrates with the existing message loop, IPC system, and task scheduler.

## Prerequisites

- A Discord Bot Token (from https://discord.dev)
- The bot must be invited to your server with `MESSAGE_CONTENT` intent enabled
- Node.js 20+

## Steps

### 1. Install dependency

```bash
npm install discord.js
```

### 2. Create `src/channels/discord.ts`

Create a new channel implementation following the `Channel` interface from `src/types.ts`.

Key design decisions:
- **JID format:** Use `discord:<channelId>` as the JID (analogous to WhatsApp's `xxx@g.us`)
- **Main channel:** The user's DM with the bot acts as the main/self-chat channel
- **Groups:** Discord text channels in servers map to NanoClaw groups
- **Trigger:** `@AssistantName` mention or configured trigger word
- **Typing:** Use `channel.sendTyping()` for typing indicators

```typescript
// src/channels/discord.ts
import { Client, Events, GatewayIntentBits, Message, TextChannel, DMChannel, Partials } from 'discord.js';
import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  token: string;
  /** Discord user ID of the bot owner (for main channel / DM detection) */
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
      partials: [Partials.Channel], // Required for DM events
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
        // Ignore own messages
        if (message.author.id === this.client.user?.id) return;
        // Ignore other bots
        if (message.author.bot) return;

        const chatJid = this.messageToJid(message);
        const timestamp = message.createdAt.toISOString();

        // Track DM channel for owner (main channel)
        if (message.channel.isDMBased() && message.author.id === this.opts.ownerId) {
          this.ownerDmChannelId = message.channelId;
        }

        // Notify about chat metadata for group discovery
        const channelName = message.channel.isDMBased()
          ? `DM:${message.author.username}`
          : ('name' in message.channel ? message.channel.name : 'unknown');
        this.opts.onChatMetadata(chatJid, timestamp, channelName);

        // Only deliver full message for registered groups
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

      // Discord has a 2000 char limit per message — split if needed
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
    if (!isTyping) return; // Discord typing auto-expires
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

  // --- Helpers ---

  private messageToJid(message: Message): string {
    return `discord:${message.channelId}`;
  }

  private jidToChannelId(jid: string): string | null {
    const match = jid.match(/^discord:(\d+)$/);
    return match ? match[1] : null;
  }

  /**
   * Determine if a JID is the owner's DM (main channel).
   */
  isMainChannel(jid: string): boolean {
    if (!this.ownerDmChannelId) return false;
    return jid === `discord:${this.ownerDmChannelId}`;
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
      // Try to split at last newline before limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) splitAt = maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
```

### 3. Add environment variables

Add to `.env`:

```bash
# Discord configuration
DISCORD_TOKEN=your-bot-token-here
DISCORD_OWNER_ID=your-discord-user-id

# Optional: change assistant name
ASSISTANT_NAME=Claw
```

Update `src/env.ts` — add `DISCORD_TOKEN` and `DISCORD_OWNER_ID` to the env reader, but **do NOT** add them to the `readEnvFile` call in `config.ts`. These are secrets and should only be read where needed (following the existing pattern for WhatsApp auth).

### 4. Modify `src/config.ts`

Add channel selection config:

```typescript
export const CHANNEL = process.env.CHANNEL || envConfig.CHANNEL || 'discord';
```

Add `'CHANNEL'` to the `readEnvFile` array.

### 5. Modify `src/index.ts`

Replace the hardcoded WhatsApp channel with dynamic channel selection.

**Key changes:**

1. Import both channels:
```typescript
import { WhatsAppChannel } from './channels/whatsapp.js';
import { DiscordChannel } from './channels/discord.js';
import { CHANNEL } from './config.js';
import { Channel } from './types.js';
```

2. Replace `let whatsapp: WhatsAppChannel` with `let channel: Channel`.

3. In `main()`, create the channel based on config:
```typescript
if (CHANNEL === 'discord') {
  // Read token only when needed (security: don't leak to child processes)
  const envSecrets = readEnvFile(['DISCORD_TOKEN', 'DISCORD_OWNER_ID']);
  const token = process.env.DISCORD_TOKEN || envSecrets.DISCORD_TOKEN;
  const ownerId = process.env.DISCORD_OWNER_ID || envSecrets.DISCORD_OWNER_ID;
  if (!token || !ownerId) {
    throw new Error('DISCORD_TOKEN and DISCORD_OWNER_ID are required');
  }
  channel = new DiscordChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
    token,
    ownerId,
  });
} else {
  channel = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });
}
```

4. Replace all `whatsapp.xxx` calls with `channel.xxx` throughout the file.

5. The `syncGroupMetadata` call in `startIpcWatcher` is WhatsApp-specific. Make it conditional:
```typescript
syncGroupMetadata: (force) => 'syncGroupMetadata' in channel
  ? (channel as any).syncGroupMetadata(force)
  : Promise.resolve(),
```

### 6. Update `storeChatMetadata` in `src/db.ts`

The existing `storeChatMetadata` only takes `(jid, timestamp)`. Discord passes an optional `name` parameter for channel discovery. Update the function signature:

```typescript
export function storeChatMetadata(jid: string, timestamp: string, name?: string): void
```

If `name` is provided, also call `updateChatName(jid, name)`.

### 7. Update `OnChatMetadata` type in `src/types.ts`

The type already has an optional `name` parameter — verify it matches:
```typescript
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
```

### 8. Main channel detection

For Discord, the "main" channel is the owner's DM. Update `MAIN_GROUP_FOLDER` usage:

When registering the owner's DM as main, the Discord channel auto-detects DMs from the owner ID. On first DM from the owner, auto-register it:

In `index.ts`, after receiving a message, if it's from the owner's DM and not yet registered, register it as the main group automatically.

### 9. Container considerations

NanoClaw agents run in containers. The container needs no Discord access — it communicates via IPC files. The existing IPC mechanism (`data/ipc/<group>/messages/`) works unchanged since messages are just JSON files with `chatJid` and `text`.

No container changes needed.

### 10. Test

```bash
# Set channel to discord
echo 'CHANNEL=discord' >> .env
echo 'DISCORD_TOKEN=your-token' >> .env
echo 'DISCORD_OWNER_ID=your-user-id' >> .env

# Start
npm start
```

Send a DM to the bot — it should auto-register as your main channel. Then mention `@Claw` (or your assistant name) in a server channel.

## Discord-specific notes

- **Message length:** Discord has a 2000 char limit. The channel implementation splits long messages automatically.
- **No prefix needed:** Unlike WhatsApp shared-number mode, Discord bots have their own identity. Set `ASSISTANT_HAS_OWN_NUMBER=true` in `.env` to skip the `AssistantName:` prefix.
- **Embeds:** For richer formatting, extend `sendMessage` to use Discord embeds for structured output (code blocks, lists, etc.). This is optional.
- **Reactions:** Discord supports emoji reactions. Consider adding a `react(jid, messageId, emoji)` method to the Channel interface for acknowledgments.
- **Thread support:** Discord threads could map to isolated sub-conversations. Future enhancement.

## Replacing WhatsApp entirely

If you only want Discord (no WhatsApp):

1. Set `CHANNEL=discord` in `.env`
2. Remove `@whiskeysockets/baileys` from dependencies: `npm uninstall @whiskeysockets/baileys`
3. Optionally delete `src/channels/whatsapp.ts` and `src/whatsapp-auth.ts`

## Running both channels simultaneously

To run both WhatsApp and Discord at the same time, modify `index.ts` to create both channels and merge their message streams. The `Channel` interface makes this straightforward — create a `MultiChannel` wrapper that routes messages based on JID prefix (`discord:` vs `@g.us`/`@s.whatsapp.net`).

This is a more advanced setup. Start with one channel and add multi-channel later if needed.
