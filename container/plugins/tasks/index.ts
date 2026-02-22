import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
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

const scheduleTaskTool: McpToolDefinition = {
  name: 'schedule_task',
  description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history.
• "isolated": Task runs in a fresh session with no conversation history.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
  parameters: z.object({
    prompt: z.string().describe('What the agent should do when the task runs.'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for.'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const scheduleType = args.schedule_type as string;
    const scheduleValue = args.schedule_value as string;

    // Validate
    if (scheduleType === 'cron') {
      try { CronExpressionParser.parse(scheduleValue); }
      catch { return { content: [{ type: 'text', text: `Invalid cron: "${scheduleValue}".` }], isError: true }; }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) return { content: [{ type: 'text', text: `Invalid interval: "${scheduleValue}".` }], isError: true };
    } else if (scheduleType === 'once') {
      if (isNaN(new Date(scheduleValue).getTime())) return { content: [{ type: 'text', text: `Invalid timestamp: "${scheduleValue}".` }], isError: true };
    }

    const targetJid = ctx.isMain && args.target_group_jid ? args.target_group_jid as string : ctx.chatJid;

    const filename = writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text', text: `Task scheduled (${filename}): ${scheduleType} - ${scheduleValue}` }] };
  },
};

const listTasksTool: McpToolDefinition = {
  name: 'list_tasks',
  description: "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  parameters: z.object({}),
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    try {
      if (!fs.existsSync(tasksFile)) return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] };

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
        id: string; prompt: string; schedule_type: string; schedule_value: string;
        status: string; next_run: string; groupFolder: string;
      }>;

      const tasks = ctx.isMain ? allTasks : allTasks.filter((t) => t.groupFolder === ctx.groupFolder);
      if (tasks.length === 0) return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] };

      const formatted = tasks.map((t) =>
        `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
      ).join('\n');

      return { content: [{ type: 'text', text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
};

function taskActionTool(action: string, description: string): McpToolDefinition {
  return {
    name: `${action}_task`,
    description,
    parameters: z.object({ task_id: z.string().describe(`The task ID to ${action}`) }),
    async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      writeIpcFile(TASKS_DIR, {
        type: `${action}_task`,
        taskId: args.task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text', text: `Task ${args.task_id as string} ${action} requested.` }] };
    },
  };
}

const plugin: Plugin = {
  manifest: undefined!,
  tools: [
    scheduleTaskTool,
    listTasksTool,
    taskActionTool('pause', 'Pause a scheduled task. It will not run until resumed.'),
    taskActionTool('resume', 'Resume a paused task.'),
    taskActionTool('cancel', 'Cancel and delete a scheduled task.'),
  ],
};

export default plugin;
