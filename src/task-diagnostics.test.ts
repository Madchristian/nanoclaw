import { describe, it, expect } from 'vitest';

import { diagnoseTaskFailure, formatFailureNotification } from './task-diagnostics.js';
import { ScheduledTask, TaskRunLog } from './types.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'main',
    chat_jid: 'group@g.us',
    prompt: 'Check Wetter',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
    retry_count: 0,
    last_error: null,
    max_retries: 3,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRunLog> = {}): TaskRunLog {
  return {
    task_id: 'task-1',
    run_at: '2024-01-01T09:00:00.000Z',
    duration_ms: 5000,
    status: 'error',
    result: null,
    error: 'Container exit code 1',
    ...overrides,
  };
}

describe('diagnoseTaskFailure', () => {
  it('detects orphaned tasks (group not found)', () => {
    const d = diagnoseTaskFailure(makeTask(), [], 'Group not found: test-group');
    expect(d.pattern).toBe('orphaned');
    expect(d.recommendation).toBe('deactivate');
  });

  it('detects rate limiting', () => {
    const d = diagnoseTaskFailure(makeTask(), [], 'HTTP 429 Too Many Requests');
    expect(d.pattern).toBe('rate-limited');
    expect(d.recommendation).toBe('retry');
  });

  it('detects timeout', () => {
    const d = diagnoseTaskFailure(makeTask(), [], 'Container timed out after 300s');
    expect(d.pattern).toBe('timeout');
    expect(d.recommendation).toBe('increase-timeout');
  });

  it('detects persistent failure (same error repeated)', () => {
    const runs = [
      makeRun({ error: 'ModuleNotFoundError: requests', run_at: '2024-01-01T09:02:00.000Z' }),
      makeRun({ error: 'ModuleNotFoundError: requests', run_at: '2024-01-01T09:01:00.000Z' }),
    ];
    const d = diagnoseTaskFailure(makeTask(), runs, 'ModuleNotFoundError: requests');
    expect(d.pattern).toBe('persistent');
    expect(d.recommendation).toBe('pause');
  });

  it('detects transient failures (different errors)', () => {
    const runs = [
      makeRun({ error: 'Connection reset', run_at: '2024-01-01T09:02:00.000Z' }),
      makeRun({ error: 'DNS lookup failed', run_at: '2024-01-01T09:01:00.000Z' }),
    ];
    const d = diagnoseTaskFailure(makeTask(), runs, 'Unexpected crash');
    expect(d.pattern).toBe('transient');
    expect(d.recommendation).toBe('retry');
  });

  it('returns unknown for single failure with no history', () => {
    const d = diagnoseTaskFailure(makeTask(), [], 'Some weird error');
    expect(d.pattern).toBe('unknown');
    expect(d.recommendation).toBe('retry');
  });

  it('ignores success runs when checking for persistent errors', () => {
    const runs = [
      makeRun({ status: 'success', error: null, run_at: '2024-01-01T09:02:00.000Z' }),
      makeRun({ error: 'fail A', run_at: '2024-01-01T09:01:00.000Z' }),
    ];
    const d = diagnoseTaskFailure(makeTask(), runs, 'fail B');
    // Only 1 prior error, not enough for persistent
    expect(d.pattern).not.toBe('persistent');
  });
});

describe('formatFailureNotification', () => {
  it('formats a readable notification', () => {
    const task = makeTask({ prompt: 'Check Wetter in Berlin' });
    const diagnosis = {
      pattern: 'persistent' as const,
      description: 'Persistenter Fehler (3x wiederholt)',
      recommendation: 'pause' as const,
      details: 'ModuleNotFoundError',
    };
    const msg = formatFailureNotification(task, diagnosis, 'ModuleNotFoundError', 'paused');
    expect(msg).toContain('⚠️ Task "Check Wetter in Berlin" fehlgeschlagen');
    expect(msg).toContain('Diagnose: Persistenter Fehler');
    expect(msg).toContain('Task wurde pausiert');
  });

  it('truncates long prompts', () => {
    const longPrompt = 'A'.repeat(100);
    const task = makeTask({ prompt: longPrompt });
    const diagnosis = {
      pattern: 'unknown' as const,
      description: 'test',
      recommendation: 'retry' as const,
    };
    const msg = formatFailureNotification(task, diagnosis, 'err', 'error');
    expect(msg).toContain('...');
    expect(msg.split('\n')[0].length).toBeLessThan(120);
  });
});
