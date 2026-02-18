---
name: add-discord
description: Add Discord as a channel. Can replace WhatsApp entirely or run alongside it. Supports guilds (servers) and DMs with trigger-based or always-respond modes.
---

# Add Discord Channel

This skill adds Discord support to NanoClaw. Users can choose to:

1. **Replace WhatsApp** — Use Discord as the only messaging channel
2. **Add alongside WhatsApp** — Both channels active
3. **Add alongside WhatsApp + Telegram** — All three channels active

## Prerequisites

### 1. Install Discord.js

```bash
npm install discord.js
```

### 2. Create a Discord Bot

Tell the user:

> I need you to create a Discord bot:
>
> 1. Go to <https://discord.com/developers/applications>
> 2. Click **New Application**, give it a name
> 3. Go to **Bot** tab:
>    - Click **Reset Token** and copy the token
>    - Enable **Message Content Intent** under Privileged Gateway Intents
>    - Enable **Server Members Intent** (for member names)
> 4. Go to **OAuth2** → **URL Generator**:
>    - Scopes: `bot`
>    - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`
>    - Copy the generated URL and open it to invite the bot to your server

Wait for user to provide the bot token.

### 3. Get Channel IDs

Tell the user:

> To register a Discord channel:
>
> 1. Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode)
> 2. Right-click a channel or DM → **Copy Channel ID**
> 3. The JID format is `dc:<channel_id>` (e.g., `dc:1234567890123456789`)
>
> I'll add a `/chatid` slash command to the bot for convenience.

## Questions to Ask

Before making changes, ask:

1. **Mode**: Replace WhatsApp or add alongside it?
   - If replace: Set `DISCORD_ONLY=true`
   - If alongside: Both will run

2. **Chat behavior**: Should registered channels respond to all messages or only when @mentioned?
   - Main channel: Responds to all (set `requiresTrigger: false`)
   - Other channels: Default requires trigger (`requiresTrigger: true`)

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface. Key files:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/whatsapp.ts` | `WhatsAppChannel` class (reference implementation) |
| `src/channels/telegram.ts` | `TelegramChannel` class (if present — another reference) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |
| `src/ipc.ts` | IPC watcher (uses `sendMessage` dep for outbound) |

The Discord channel follows the same pattern:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add Discord config exports:

```typescript
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
export const DISCORD_ONLY = process.env.DISCORD_ONLY === "true";
```

These should be added near the top with other configuration exports.

### Step 2: Create Discord Channel

Create `src/channels/discord.ts` implementing the `Channel` interface. Use `src/channels/whatsapp.ts` as the pattern reference.

```typescript
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Message as DiscordMessage,
  ChannelType,
} from "discord.js";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from "../types.js";

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = "discord";

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private botUserId: string | null = null;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        this.botUserId = readyClient.user.id;
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          "Discord bot connected",
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use Developer Mode to copy Channel IDs for registration\n`,
        );
        resolve();
      });

      this.client!.on(Events.MessageCreate, async (msg: DiscordMessage) => {
        await this.handleMessage(msg);
      });

      this.client!.on(Events.Error, (err) => {
        logger.error({ err: err.message }, "Discord client error");
      });

      this.client!.login(this.botToken).catch(reject);
    });
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    // Ignore own messages
    if (msg.author.id === this.botUserId) return;
    // Ignore other bots
    if (msg.author.bot) return;

    const chatJid = `dc:${msg.channelId}`;
    let content = msg.content;
    const timestamp = msg.createdAt.toISOString();
    const senderName =
      msg.member?.displayName || msg.author.displayName || msg.author.username;
    const sender = msg.author.id;
    const msgId = msg.id;

    // Determine chat name
    let chatName: string;
    if (msg.channel.type === ChannelType.DM) {
      chatName = senderName;
    } else if ("name" in msg.channel && msg.channel.name) {
      const guildName = msg.guild?.name || "";
      chatName = guildName ? `${guildName} #${msg.channel.name}` : msg.channel.name;
    } else {
      chatName = chatJid;
    }

    // Translate @bot mentions into TRIGGER_PATTERN format.
    // Discord renders mentions as <@BOT_ID> in message content.
    if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
      // Remove the raw mention and prepend trigger-compatible format
      content = content.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Handle attachments as placeholders
    if (msg.attachments.size > 0) {
      const attachmentDescs = msg.attachments.map((a) => {
        const type = a.contentType?.startsWith("image/")
          ? "Image"
          : a.contentType?.startsWith("video/")
            ? "Video"
            : a.contentType?.startsWith("audio/")
              ? "Audio"
              : "File";
        return `[${type}: ${a.name}]`;
      });
      content = content
        ? `${content}\n${attachmentDescs.join("\n")}`
        : attachmentDescs.join("\n");
    }

    // Handle stickers
    if (msg.stickers.size > 0) {
      const stickerDescs = msg.stickers.map((s) => `[Sticker: ${s.name}]`);
      content = content
        ? `${content}\n${stickerDescs.join("\n")}`
        : stickerDescs.join("\n");
    }

    // Skip empty messages (e.g., embed-only)
    if (!content.trim()) return;

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        "Message from unregistered Discord channel",
      );
      return;
    }

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      "Discord message stored",
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn("Discord client not initialized");
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, "");
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !("send" in channel)) {
        logger.error({ jid }, "Discord channel not found or not text-based");
        return;
      }

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await (channel as any).send(text);
      } else {
        // Split on newlines when possible, otherwise hard-split
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
          if (remaining.length <= MAX_LENGTH) {
            chunks.push(remaining);
            break;
          }
          // Try to find a newline near the limit
          let splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);
          if (splitAt < MAX_LENGTH * 0.5) {
            // No good newline break — split at space
            splitAt = remaining.lastIndexOf(" ", MAX_LENGTH);
          }
          if (splitAt < MAX_LENGTH * 0.3) {
            // No good break at all — hard split
            splitAt = MAX_LENGTH;
          }
          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).trimStart();
        }
        for (const chunk of chunks) {
          await (channel as any).send(chunk);
        }
      }
      logger.info({ jid, length: text.length }, "Discord message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Discord message");
    }
  }

  isConnected(): boolean {
    return this.client?.isReady() ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("dc:");
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info("Discord bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, "");
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "sendTyping" in channel) {
        await (channel as any).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Discord typing indicator");
    }
  }
}
```

Key design points:
- **JID format:** `dc:<channel_id>` — consistent with `tg:` prefix pattern
- **@mention translation:** Discord renders mentions as `<@BOT_ID>`. The channel strips these and prepends `@ASSISTANT_NAME` so TRIGGER_PATTERN matches
- **Message splitting:** Discord's 2000 char limit requires smart splitting (newlines > spaces > hard split)
- **Attachments/stickers:** Rendered as `[Image: filename.png]`, `[Sticker: name]` placeholders
- **DM support:** Via `Partials.Channel` — Discord requires this for DM events
- **No `prefixAssistantName`:** Discord bots display their name via the bot user profile

### Step 3: Update Main Application

Modify `src/index.ts` to support the Discord channel. Read the file first to understand the current structure.

1. **Add imports** at the top:

```typescript
import { DiscordChannel } from "./channels/discord.js";
import { DISCORD_BOT_TOKEN, DISCORD_ONLY } from "./config.js";
```

2. **Create the Discord channel** in `main()`, alongside existing channels:

```typescript
// In the channel creation section of main():
if (DISCORD_BOT_TOKEN) {
  const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
  channels.push(discord);
  await discord.connect();
}
```

3. **Update channel-only mode check** if DISCORD_ONLY is set:

```typescript
// Skip WhatsApp if Discord-only or Telegram-only
const skipWhatsApp = DISCORD_ONLY || TELEGRAM_ONLY;
if (!skipWhatsApp) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}
```

4. **Update `getAvailableGroups`** to include Discord channels:

```typescript
// In the filter, add dc: prefix:
.filter((c) => c.jid !== '__group_sync__' && (
  c.jid.endsWith('@g.us') ||
  c.jid.startsWith('tg:') ||
  c.jid.startsWith('dc:')
))
```

### Step 4: Update Environment

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN_HERE

# Optional: Set to "true" to disable WhatsApp entirely
# DISCORD_ONLY=true
```

**Important**: After modifying `.env`, sync to the container environment:

```bash
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Step 5: Register a Discord Channel

After the bot is running and invited to a server, register channels.

Registration uses `registerGroup()` in `src/index.ts`:

```typescript
// For a DM channel (main group, responds to all):
registerGroup("dc:1234567890123456789", {
  name: "Personal DM",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});

// For a server channel (requires @mention or trigger):
registerGroup("dc:9876543210987654321", {
  name: "MyServer #general",
  folder: "discord-general",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

Alternatively, if the agent is already running, register via IPC using the `register_group` task type.

### Step 6: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or for systemd:

```bash
npm run build
systemctl --user restart nanoclaw
```

### Step 7: Test

Tell the user:

> Send a message in a registered Discord channel:
> - For main channel: Any message works
> - For non-main: `@BotName hello` or @mention the bot
>
> Check logs: `tail -f logs/nanoclaw.log`

## Replace WhatsApp Entirely

If user wants Discord-only:

1. Set `DISCORD_ONLY=true` in `.env`
2. Run `cp .env data/env/env` to sync to container
3. The WhatsApp channel is not created — only Discord
4. All services (scheduler, IPC watcher, queue, message loop) start normally

## Features

### JID Formats

| Platform | Format | Example |
|----------|--------|---------|
| WhatsApp | `<number>@g.us` / `<number>@s.whatsapp.net` | `120363336345536173@g.us` |
| Telegram | `tg:<chat_id>` | `tg:-1001234567890` |
| Discord | `dc:<channel_id>` | `dc:1234567890123456789` |

### Trigger Options

The bot responds when:
1. Channel has `requiresTrigger: false` (e.g., main/DM channel)
2. Bot is @mentioned in Discord (translated to TRIGGER_PATTERN automatically)
3. Message matches TRIGGER_PATTERN directly (e.g., starts with `@Andy`)

Discord @mentions (`<@BOT_ID>`) are automatically translated: the raw mention is stripped and `@ASSISTANT_NAME` is prepended so TRIGGER_PATTERN matches. This ensures @mentioning the bot always triggers a response.

### Discord-Specific Behavior

- **Message Content Intent** must be enabled in the Developer Portal, or the bot receives empty message content
- **DMs** require `Partials.Channel` — without it, DM events are silently dropped
- **2000 char limit** — messages are split intelligently at newlines or spaces
- **Typing indicator** uses `sendTyping()` which shows for ~10 seconds. For long agent runs, the typing indicator will expire before the response. This is acceptable — Discord users are used to this.
- **Embeds and components** are received but not parsed — only `msg.content` is processed. Attachment URLs are noted as placeholders.
- **Thread support** is not included in this base implementation. Threads share the parent channel ID in Discord.js by default, so messages in threads of a registered channel will be picked up automatically. To isolate threads, a future enhancement could use thread IDs as separate JIDs.

### Rate Limits

Discord enforces rate limits on the API. `discord.js` handles these automatically with built-in retry logic. No additional handling needed unless sending many messages in rapid succession (>5 messages per 5 seconds per channel).

## Troubleshooting

### Bot not responding

Check:
1. `DISCORD_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. **Message Content Intent** is enabled in Discord Developer Portal → Bot settings
3. Channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'"`
4. For non-main channels: message @mentions the bot or matches trigger pattern
5. Service is running: `launchctl list | grep nanoclaw`

### Bot sees messages but content is empty

**Message Content Intent** is not enabled. Go to Discord Developer Portal → your app → Bot → Privileged Gateway Intents → enable **Message Content Intent**.

### Bot not receiving DMs

Ensure `Partials.Channel` is included in the client options. Without it, DM channels aren't cached and events are dropped.

### Getting channel IDs

1. Open Discord Settings → Advanced → enable **Developer Mode**
2. Right-click any channel → **Copy Channel ID**
3. Prefix with `dc:` for registration: `dc:1234567890123456789`

### Service conflicts

If running `npm run dev` while launchd service is active:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Multi-Channel Setup

Running Discord alongside WhatsApp and/or Telegram works out of the box:

1. Set all tokens in `.env`:
   ```bash
   DISCORD_BOT_TOKEN=...
   TELEGRAM_BOT_TOKEN=...
   # Don't set any *_ONLY flags
   ```
2. Each channel registers with its JID prefix (`dc:`, `tg:`, `@g.us`)
3. `findChannel()` in `src/router.ts` routes outbound messages to the correct channel based on JID prefix
4. IPC, scheduler, and message loop all work channel-agnostically

## Removal

To remove Discord integration:

1. Delete `src/channels/discord.ts`
2. Remove `DiscordChannel` import and creation from `src/index.ts`
3. Remove `dc:` from `getAvailableGroups()` filter
4. Remove Discord config (`DISCORD_BOT_TOKEN`, `DISCORD_ONLY`) from `src/config.ts`
5. Remove Discord registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'dc:%'"`
6. Uninstall: `npm uninstall discord.js`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
