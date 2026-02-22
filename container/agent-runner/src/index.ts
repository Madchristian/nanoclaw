/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  /** Platform user IDs of message senders that triggered this container run */
  senderIds?: string[];
  /** Trust configuration for owner-based permission checks */
  trustConfig?: { ownerId: string };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input: any, _toolUseId: any, _context: any) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Delegated trust entry — temporary elevated permissions for non-owner users.
 * Stored in /workspace/group/trusted_users.json, managed by the owner.
 */
interface TrustedUser {
  userId: string;       // Discord user ID
  name: string;         // Human-readable name (for logging)
  level: 'read' | 'operate' | 'admin'; // Permission level
  expiresAt?: string;   // ISO timestamp — undefined = permanent until removed
  grantedBy: string;    // Who granted this (should always be owner)
  grantedAt: string;    // When granted
  note?: string;        // Optional reason
}

interface TrustedUsersConfig {
  users: TrustedUser[];
}

const TRUSTED_USERS_PATH = '/workspace/config/trusted-users.json';

/**
 * Permission levels:
 * - read:    kubectl get/describe/logs, status checks, monitoring
 * - operate: read + Home Assistant control, kubectl rollout restart, backups
 * - admin:   operate + most destructive ops (but NOT user mgmt, firewall, or secrets rotation)
 *
 * Owner always has full access regardless of this file.
 */
function loadTrustedUsers(): TrustedUser[] {
  try {
    if (!fs.existsSync(TRUSTED_USERS_PATH)) return [];
    const config: TrustedUsersConfig = JSON.parse(fs.readFileSync(TRUSTED_USERS_PATH, 'utf-8'));
    const now = new Date();
    // Filter expired entries
    return (config.users || []).filter(u => {
      if (!u.expiresAt) return true;
      return new Date(u.expiresAt) > now;
    });
  } catch (err) {
    log(`Failed to load trusted users: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function getTrustLevel(userId: string, ownerId: string): 'owner' | 'admin' | 'operate' | 'read' | 'none' {
  if (userId === ownerId) return 'owner';
  const trusted = loadTrustedUsers();
  const entry = trusted.find(u => u.userId === userId);
  if (entry) {
    log(`Delegated trust: ${entry.name} (${entry.userId}) → level=${entry.level}, expires=${entry.expiresAt || 'never'}`);
    return entry.level;
  }
  return 'none';
}

// Commands allowed for 'read' level (safe, no state changes)
const READ_SAFE_PATTERNS: RegExp[] = [
  /^\s*kubectl\s+(get|describe|logs|top|version|cluster-info)\b/,
  /^\s*flux\s+(get|logs|stats)\b/,
  /^\s*helm\s+(list|status|get)\b/,
  /^\s*cat\b/,
  /^\s*ls\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*df\b/,
  /^\s*du\b/,
  /^\s*uptime\b/,
  /^\s*free\b/,
  /^\s*top\b/,
  /^\s*curl\s+.*\bgoogle\.com\b/,  // Safe web lookups
];

// Commands allowed for 'operate' level (includes read + controlled mutations)
const OPERATE_PATTERNS: RegExp[] = [
  /^\s*kubectl\s+rollout\s+restart\b/,
  /^\s*kubectl\s+scale\b/,
  /^\s*curl\s+.*homeassistant\b/,
  /^\s*curl\s+.*10\.0\.30\.5\b/,  // Home Assistant
];

// Commands still blocked even for 'admin' (owner-only forever)
const OWNER_ONLY_PATTERNS: RegExp[] = [
  /\buserdel\b/,
  /\buseradd\b/,
  /\bpasswd\b/,
  /\biptables\b/,
  /\bnft\b/,
  /\bufw\b/,
  /\bssh-keygen\b/,
  /\bauthorized_keys\b/,
  /\bprintenv\b.*\b(KEY|TOKEN|SECRET|PASSWORD)\b/i,
  /\bcat\s+.*\.(env|key|pem|crt|secret)/,
];

/**
 * DESTRUCTIVE COMMAND PATTERNS — blocked for non-owner triggers.
 * These patterns match common destructive operations that could damage
 * the homelab infrastructure. Only the owner can trigger these.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // File deletion
  /\brm\s+(-[a-zA-Z]*\s+)*\//,           // rm with absolute paths
  /\brm\s+(-[a-zA-Z]*\s+)*~/,            // rm with home paths
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,        // rm -rf / rm -fr variants
  /\brmdir\b/,
  /\bshred\b/,
  // Kubernetes destructive
  /\bkubectl\s+(delete|drain|cordon|uncordon|taint)\b/,
  /\bkubectl\s+scale\b/,
  /\bkubectl\s+(apply|create|patch|replace|edit)\b/,
  /\bflux\s+(suspend|resume|delete)\b/,
  /\bhelm\s+(uninstall|delete|rollback)\b/,
  // Service management
  /\bsystemctl\s+(stop|restart|disable|mask)\b/,
  /\bservice\s+\S+\s+(stop|restart)\b/,
  // SSH with destructive potential
  /\bssh\s+.*\b(rm|rmdir|dd|mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)\b/,
  // Disk/filesystem destructive
  /\bdd\s+.*\bof=/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  // System destructive
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  // User management
  /\buserdel\b/,
  /\buseradd\b/,
  /\bpasswd\b/,
  // Network/firewall
  /\biptables\b/,
  /\bnft\b/,
  /\bufw\s+(delete|disable|reset)\b/,
  // Docker/container destructive
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm)\b/,
  /\bcrictl\s+(rm|rmp)\b/,
  // Secrets exfiltration
  /\bcat\s+.*\.(env|key|pem|crt|secret)/,
  /\bprintenv\b.*\b(KEY|TOKEN|SECRET|PASSWORD)\b/i,
];

/**
 * PreToolUse hook that blocks destructive Bash commands when the
 * triggering user(s) are not the owner. This is a CODE-LEVEL check
 * that cannot be bypassed by prompt injection.
 */
function createOwnerGuardHook(containerInput: ContainerInput): HookCallback {
  return async (input: any, _toolUseId: any, _context: any) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const { trustConfig, senderIds, isScheduledTask } = containerInput;
    if (!trustConfig) return {}; // No trust config = no enforcement (fallback to prompt-level)

    // Scheduled tasks are owner-configured, treat as owner-triggered
    if (isScheduledTask) return {};

    // Determine the effective trust level (lowest level among all senders)
    type TrustLevel = 'owner' | 'admin' | 'operate' | 'read' | 'none';
    const levels: TrustLevel[] = ['owner', 'admin', 'operate', 'read', 'none'];
    const effectiveLevel: TrustLevel = senderIds?.length
      ? senderIds.reduce<TrustLevel>((lowest, id) => {
          const level = getTrustLevel(id, trustConfig.ownerId);
          return levels.indexOf(level) > levels.indexOf(lowest) ? level : lowest;
        }, 'owner')
      : 'none'; // No sender info = assume no trust

    // Owner gets full access
    if (effectiveLevel === 'owner') return {};

    // Owner-only commands — blocked for everyone except owner, even admins
    for (const pattern of OWNER_ONLY_PATTERNS) {
      if (pattern.test(command)) {
        log(`🚫 BLOCKED owner-only command (level=${effectiveLevel}): ${command.slice(0, 200)}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason: `🚫 Blocked: Dieser Befehl ist ausschließlich dem Owner vorbehalten (Usermanagement, Firewall, Secrets). Keine Delegation möglich.`,
          },
        };
      }
    }

    // Admin level — can do most things except owner-only
    if (effectiveLevel === 'admin') return {};

    // Operate level — check if command is in operate or read patterns
    if (effectiveLevel === 'operate') {
      const isOperateAllowed = OPERATE_PATTERNS.some(p => p.test(command)) ||
                                READ_SAFE_PATTERNS.some(p => p.test(command));
      if (isOperateAllowed) return {};

      // Check if it's destructive
      const isDestructive = DESTRUCTIVE_PATTERNS.some(p => p.test(command));
      if (isDestructive) {
        log(`🚫 BLOCKED destructive command for operate-level user: ${command.slice(0, 200)}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason: `🚫 Blocked: Dein Trust-Level (operate) erlaubt diesen destructive Befehl nicht. Frag Christian um Freigabe.`,
          },
        };
      }
      // Non-destructive, non-listed commands: allow (e.g., echo, python, etc.)
      return {};
    }

    // Read level — only safe read commands
    if (effectiveLevel === 'read') {
      const isReadAllowed = READ_SAFE_PATTERNS.some(p => p.test(command));
      if (isReadAllowed) return {};

      log(`🚫 BLOCKED command for read-level user: ${command.slice(0, 200)}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: `🚫 Blocked: Dein Trust-Level (read) erlaubt nur lesende Befehle. Frag Christian um erweiterte Rechte.`,
        },
      };
    }

    // No trust — block all destructive commands
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        log(`🚫 BLOCKED destructive command from untrusted user: ${command.slice(0, 200)}`);
        log(`   Senders: ${senderIds?.join(', ') || 'unknown'}, Owner: ${trustConfig.ownerId}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason: `🚫 Blocked: Dieser Befehl erfordert Owner-Berechtigung (Discord ID: ${trustConfig.ownerId}). Nur Christian kann destructive/sensitive Befehle freigeben.`,
          },
        };
      }
    }

    return {};
  };
}

/**
 * PreToolUse hook that restricts Write/Edit tools based on trust level.
 * Prevents non-owner users from modifying security-critical files.
 */
function createFileGuardHook(containerInput: ContainerInput): HookCallback {
  return async (input: any, _toolUseId: any, _context: any) => {
    const preInput = input as PreToolUseHookInput;
    const filePath = (preInput.tool_input as { file_path?: string })?.file_path;
    if (!filePath) return {};

    const { trustConfig, senderIds, isScheduledTask } = containerInput;
    if (!trustConfig) return {};
    if (isScheduledTask) return {};

    type TrustLevel = 'owner' | 'admin' | 'operate' | 'read' | 'none';
    const levels: TrustLevel[] = ['owner', 'admin', 'operate', 'read', 'none'];
    const effectiveLevel: TrustLevel = senderIds?.length
      ? senderIds.reduce<TrustLevel>((lowest, id) => {
          const level = getTrustLevel(id, trustConfig.ownerId);
          return levels.indexOf(level) > levels.indexOf(lowest) ? level : lowest;
        }, 'owner')
      : 'none';

    if (effectiveLevel === 'owner' || effectiveLevel === 'admin') return {};

    if (effectiveLevel === 'none' || effectiveLevel === 'read') {
      log(`🚫 BLOCKED file write from ${effectiveLevel}-level user: ${filePath.slice(0, 200)}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: `🚫 Blocked: Dein Trust-Level (${effectiveLevel}) erlaubt keine Dateiänderungen.`,
        },
      };
    }

    // operate level: only allow writes within /workspace/group/
    const resolved = path.resolve(filePath);
    const blockedPrefixes = ['/workspace/config/', '/workspace/global/', '/home/node/.claude/'];
    for (const prefix of blockedPrefixes) {
      if (resolved.startsWith(prefix)) {
        log(`🚫 BLOCKED file write to protected path (operate-level): ${resolved.slice(0, 200)}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            decision: 'block',
            reason: `🚫 Blocked: Schreibzugriff auf ${prefix} erfordert Admin- oder Owner-Berechtigung.`,
          },
        };
      }
    }
    if (!resolved.startsWith('/workspace/group/')) {
      log(`🚫 BLOCKED file write outside /workspace/group/ (operate-level): ${resolved.slice(0, 200)}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: `🚫 Blocked: Operate-Level erlaubt nur Schreibzugriff innerhalb von /workspace/group/.`,
        },
      };
    }

    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input: any, _toolUseId: any, _context: any) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [createOwnerGuardHook(containerInput), createSanitizeBashHook()] },
          { matcher: 'Write', hooks: [createFileGuardHook(containerInput)] },
          { matcher: 'Edit', hooks: [createFileGuardHook(containerInput)] },
        ],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
