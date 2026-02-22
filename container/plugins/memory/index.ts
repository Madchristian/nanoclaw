import { z } from 'zod';
import { execFileSync } from 'child_process';
import type { Plugin, McpToolDefinition, ToolContext, ToolResult } from '../../../src/plugins/types.js';

const memorySearchTool: McpToolDefinition = {
  name: 'memory_search',
  description: `Semantically search through your memory files (MEMORY.md, daily notes, conversations) using embeddings.
Use this BEFORE answering questions about prior conversations, decisions, people, preferences, or anything that happened in the past.
Returns the most relevant snippets with file path and line numbers.`,
  parameters: z.object({
    query: z.string().describe('Search query — what are you looking for in memory?'),
    topK: z.number().optional().describe('Number of results (default: 5)'),
    minScore: z.number().optional().describe('Minimum similarity score 0-1 (default: 0.3)'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topK = (args.topK as number) || 5;
    const minScore = (args.minScore as number) || 0.3;

    try {
      const result = execFileSync('python3', [
        '/usr/local/bin/memory_search', args.query as string,
        '--top-k', String(topK), '--min-score', String(minScore),
        '--memory-dir', '/workspace/group', '--json',
      ], {
        timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OLLAMA_BASE_URL: 'http://192.168.64.1:30068' },
      });

      const results = JSON.parse(result.trim() || '[]') as Array<{
        score: number; path: string; startLine: number; endLine: number; snippet: string;
      }>;

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
      }

      const formatted = results.map((r) =>
        `**[${r.score}] ${r.path}#L${r.startLine}-L${r.endLine}**\n${r.snippet}`,
      ).join('\n\n---\n\n');

      return { content: [{ type: 'text', text: formatted }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Memory search error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
};

const plugin: Plugin = {
  manifest: undefined!,
  tools: [memorySearchTool],
};

export default plugin;
