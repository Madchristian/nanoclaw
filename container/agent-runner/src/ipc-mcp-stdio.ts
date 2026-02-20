/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Loads container plugins and registers their tools with the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';

import { PluginRegistry, PluginEventBus, createToolContext, createPluginContext } from '../../../src/plugins/index.js';
import type { ContextServices, IpcService, MessageService, TaskService, Logger } from '../../../src/plugins/index.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(IPC_DIR + path.sep) && resolvedDir !== IPC_DIR) {
    throw new Error(`IPC write denied: path escapes IPC directory: ${dir}`);
  }
  fs.mkdirSync(resolvedDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// --- Service implementations for container-side plugins ---

const logger: Logger = {
  info: (msg, ...args) => console.error(`[INFO] ${msg}`, ...args),
  warn: (msg, ...args) => console.error(`[WARN] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg, ...args) => { if (process.env.DEBUG) console.error(`[DEBUG] ${msg}`, ...args); },
};

const events = new PluginEventBus();

const ipcService: IpcService = {
  writeFile: (dir, data) => writeIpcFile(dir, data),
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
};

const messageService: MessageService = {
  send(jid: string, text: string, sender?: string) {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid: jid,
      text,
      sender: sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
  },
  sendVoice(jid: string, audioPath: string) {
    writeIpcFile(MESSAGES_DIR, {
      type: 'voice_message',
      chatJid: jid,
      audioPath,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
  },
};

const taskService: TaskService = {
  schedule: () => { throw new Error('Use schedule_task tool'); },
  list: () => { throw new Error('Use list_tasks tool'); },
  pause: () => { throw new Error('Use pause_task tool'); },
  resume: () => { throw new Error('Use resume_task tool'); },
  cancel: () => { throw new Error('Use cancel_task tool'); },
};

const services: ContextServices = { logger, events, ipc: ipcService, messages: messageService, tasks: taskService };

// --- Plugin discovery & MCP registration ---

const PLUGIN_DIRS = [
  path.resolve(import.meta.dirname, '../../../container/plugins'),
  // Future: user plugin directories
];

const registry = new PluginRegistry({
  pluginDirs: PLUGIN_DIRS,
  target: 'container',
  services,
});

await registry.loadAll();

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

// Register all plugin tools with the MCP server
for (const plugin of registry.getToolPlugins()) {
  if (!plugin.tools) continue;

  const pluginCtx = createPluginContext(plugin.manifest, services);

  for (const tool of plugin.tools) {
    const toolCtx = createToolContext(pluginCtx, chatJid, groupFolder, isMain);

    // Extract the Zod shape for MCP server registration
    const shape = 'shape' in tool.parameters ? (tool.parameters as { shape: Record<string, unknown> }).shape : {};

    server.tool(
      tool.name,
      tool.description,
      shape as Record<string, never>,
      async (args: Record<string, unknown>) => tool.handler(args, toolCtx),
    );
  }
}

logger.info(`Loaded ${registry.getAll().length} plugins, ${registry.getToolPlugins().reduce((n, p) => n + (p.tools?.length ?? 0), 0)} tools`);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
