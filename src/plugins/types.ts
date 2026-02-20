/**
 * Plugin System Types & Manifest Schema
 */

import { z } from 'zod';

// --- Capability enum ---

export const Capability = z.enum([
  'ipc:read', 'ipc:write',
  'fs:read', 'fs:write',
  'network',
  'shell',
  'messages:read', 'messages:write',
  'tasks:manage',
  'groups:manage',
]);

export type Capability = z.infer<typeof Capability>;

// --- Plugin Manifest (plugin.json) ---

export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  target: z.enum(['host', 'container', 'both']),
  capabilities: z.array(Capability).default([]),
  dependencies: z.array(z.string()).default([]),
  main: z.string().default('index.ts'),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// --- Logger interface ---

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// --- Service interfaces (capability-gated) ---

export interface IpcService {
  writeFile(dir: string, data: object): string;
  readFile(filePath: string): string;
}

export interface MessageService {
  send(chatJid: string, text: string, sender?: string): void;
  sendVoice(chatJid: string, audioPath: string): void;
}

export interface TaskService {
  schedule(data: object): string;
  list(groupFolder: string, isMain: boolean): object[];
  pause(taskId: string): void;
  resume(taskId: string): void;
  cancel(taskId: string): void;
}

// --- Event Bus interface ---

export interface EventMap {
  'message:inbound': { chatJid: string; content: string; sender: string };
  'message:outbound': { chatJid: string; text: string };
  'container:start': { groupFolder: string; containerName: string };
  'container:stop': { groupFolder: string; containerName: string };
  'task:created': { taskId: string; groupFolder: string };
  'task:completed': { taskId: string; groupFolder: string };
  'plugin:loaded': { name: string };
  'plugin:unloaded': { name: string };
}

export interface EventBus {
  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void;
  off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void;
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): Promise<void>;
}

// --- Plugin Context ---

export interface PluginContext {
  logger: Logger;
  events: EventBus;
  config: Record<string, unknown>;
  ipc: IpcService;
  messages: MessageService;
  tasks: TaskService;
}

export interface ToolContext extends PluginContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

// --- Tool definitions ---

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// --- Inbound message (for host hooks) ---

export interface InboundMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

// --- Plugin interface ---

export interface Plugin {
  manifest: PluginManifest;

  // Lifecycle
  onLoad?(ctx: PluginContext): Promise<void>;
  onUnload?(): Promise<void>;

  // Host-side hooks
  onMessage?(message: InboundMessage): Promise<InboundMessage | null>;
  onBeforeSend?(jid: string, text: string): Promise<string | null>;
  onAfterSend?(jid: string, text: string): Promise<void>;
  onIpc?(data: Record<string, unknown>, sourceGroup: string): Promise<boolean>;

  // Container-side: MCP tool definitions
  tools?: McpToolDefinition[];
}

// --- Plugin module export shape ---

export interface PluginModule {
  default: Plugin;
}
