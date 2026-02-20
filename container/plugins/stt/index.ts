import { z } from 'zod';
import { execFileSync } from 'child_process';
import type { Plugin, McpToolDefinition, ToolContext, ToolResult } from '../../../src/plugins/types.js';

const speechToTextTool: McpToolDefinition = {
  name: 'speech_to_text',
  description: `Transcribe audio from a file path or URL using faster-whisper (runs locally, no API key needed).
Use this when you receive a voice message (indicated by [voice_message: <url>] in the message).
Downloads the audio, transcribes it, and returns the text.`,
  parameters: z.object({
    audio: z.string().describe('Audio file path or URL (supports ogg, mp3, wav, webm)'),
    language: z.string().optional().describe('Language code (default: de)'),
    model: z.enum(['tiny', 'base', 'small']).optional().describe('Whisper model size (default: base)'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const language = (args.language as string) || 'de';
    const model = (args.model as string) || 'base';

    try {
      const result = execFileSync('python3', [
        '/usr/local/bin/stt', args.audio as string, '--model', model, '--language', language,
      ], { timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

      const text = result.trim();
      if (!text) {
        return { content: [{ type: 'text', text: 'No speech detected in audio.' }] };
      }

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `STT error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
};

const plugin: Plugin = {
  manifest: undefined!,
  tools: [speechToTextTool],
};

export default plugin;
