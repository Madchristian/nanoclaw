import { z } from 'zod';
import type { Plugin, McpToolDefinition, ToolContext, ToolResult } from '../../../src/plugins/types.js';

const sendMessageTool: McpToolDefinition = {
  name: 'send_message',
  description: "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  parameters: z.object({
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    ctx.messages.send(ctx.chatJid, args.text as string, args.sender as string | undefined);
    return { content: [{ type: 'text', text: 'Message sent.' }] };
  },
};

const plugin: Plugin = {
  manifest: undefined!,
  tools: [sendMessageTool],
};

export default plugin;
