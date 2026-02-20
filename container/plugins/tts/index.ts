import { z } from 'zod';
import { execFileSync } from 'child_process';
import fs from 'fs';
import type { Plugin, McpToolDefinition, ToolContext, ToolResult } from '../../../src/plugins/types.js';

const textToSpeechTool: McpToolDefinition = {
  name: 'text_to_speech',
  description: `Convert text to speech and send as voice message. Uses Microsoft Neural voices (edge-tts).
The audio file is sent via IPC as a voice message attachment to the current chat.

Available German voices:
• de-DE-KillianNeural (male, default — matches Claw's voice)
• de-DE-ConradNeural (male, deeper)
• de-DE-FlorianMultilingualNeural (male, multilingual/natural)
• de-DE-SeraphinaMultilingualNeural (female, multilingual/natural)
• de-DE-AmalaNeural (female)`,
  parameters: z.object({
    text: z.string().describe('Text to convert to speech'),
    voice: z.string().optional().describe('Voice name (default: de-DE-KillianNeural)'),
    rate: z.string().optional().describe('Speech rate adjustment (default: +20%)'),
    pitch: z.string().optional().describe('Pitch adjustment (default: -8Hz)'),
  }),
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const voice = (args.voice as string) || 'de-DE-KillianNeural';
    const rate = (args.rate as string) || '+20%';
    const pitch = (args.pitch as string) || '-8Hz';
    const outputPath = `/tmp/tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`;

    try {
      execFileSync('edge-tts', [
        '--voice', voice, '--rate', rate, '--pitch', pitch,
        '--text', args.text as string, '--write-media', outputPath,
      ], { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });

      if (!fs.existsSync(outputPath)) {
        return { content: [{ type: 'text', text: 'TTS failed: no output file generated' }], isError: true };
      }

      ctx.messages.sendVoice(ctx.chatJid, outputPath);
      return { content: [{ type: 'text', text: `Voice message sent (${voice}, ${rate}).` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `TTS error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
};

const plugin: Plugin = {
  manifest: undefined!,
  tools: [textToSpeechTool],
};

export default plugin;
