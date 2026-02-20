import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { Plugin, McpToolDefinition, ToolContext, ToolResult } from '../../../src/plugins/types.js';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const registerGroupTool: McpToolDefinition = {
  name: 'register_group',
  description: `Register a new WhatsApp group so the agent can respond to messages there. Main group only.
Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens.`,
  parameters: z.object({
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens)'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.isMain) {
      return { content: [{ type: 'text', text: 'Only the main group can register new groups.' }], isError: true };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text', text: `Group "${args.name as string}" registered. It will start receiving messages immediately.` }] };
  },
};

const plugin: Plugin = {
  manifest: undefined!,
  tools: [registerGroupTool],
};

export default plugin;
