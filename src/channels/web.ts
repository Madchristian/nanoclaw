/**
 * Web Channel for NanoClaw
 * Communicates directly via the local dashboard (WebSocket).
 * No external messaging platform needed.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const WEB_JID_PREFIX = 'web:';
const DEFAULT_CHAT_JID = 'web:main';

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  ownerId: string;
  port: number;
}

export class WebChannel implements Channel {
  name = 'web';

  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private connected = false;
  private opts: WebChannelOpts;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({
        port: this.opts.port,
        host: '127.0.0.1',
      });

      this.wss.on('listening', () => {
        this.connected = true;
        logger.info({ port: this.opts.port }, 'Web channel WebSocket listening');

        // Auto-register the default web chat
        const groups = this.opts.registeredGroups();
        if (!groups[DEFAULT_CHAT_JID] && this.opts.registerGroup) {
          this.opts.registerGroup(DEFAULT_CHAT_JID, {
            name: 'Web Dashboard',
            folder: 'main',
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: false,
          });
        }

        resolve();
      });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        logger.info({ clients: this.clients.size }, 'Dashboard client connected');

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'message' && msg.text) {
              const chatJid = msg.chatJid || DEFAULT_CHAT_JID;
              const timestamp = new Date().toISOString();
              const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

              this.opts.onChatMetadata(chatJid, timestamp, 'Web Dashboard');
              this.opts.onMessage(chatJid, {
                id: msgId,
                chat_jid: chatJid,
                sender: this.opts.ownerId,
                sender_name: 'You',
                content: msg.text,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
              });
            }
          } catch (err) {
            logger.warn({ err }, 'Invalid WebSocket message');
          }
        });

        ws.on('close', () => {
          this.clients.delete(ws);
          logger.debug({ clients: this.clients.size }, 'Dashboard client disconnected');
        });
      });

      this.wss.on('error', (err) => {
        logger.error({ err }, 'WebSocket server error');
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'message',
      chatJid: jid,
      text,
      sender: ASSISTANT_NAME,
      timestamp: new Date().toISOString(),
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WEB_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const payload = JSON.stringify({ type: 'typing', chatJid: jid, isTyping });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
