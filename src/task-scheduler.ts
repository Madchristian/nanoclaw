import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getRecentTaskRuns,
  getTaskById,
  getTasksByStatus,
  incrementTaskRetryCount,
  logTaskRun,
  resetTaskRetryCount,
  updateTaskAfterRun,
  updateTaskStatus,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { diagnoseTaskFailure, formatFailureNotification, TaskDiagnosis } from './task-diagnostics.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/** Retry delays in milliseconds: 30s, 2min, 10min */
const RETRY_DELAYS = [30_000, 120_000, 600_000];

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export interface SchedulerHealth {
  totalTasks: number;
  activeTasks: number;
  pausedTasks: number;
  errorTasks: number;
  recentFailures: Array<{
    taskId: string;
    prompt: string;
    failCount: number;
    lastError: string;
    diagnosis: TaskDiagnosis;
  }>;
}

export function getSchedulerHealth(): SchedulerHealth {
  const allTasks = getAllTasks();
  const errorTasks = getTasksByStatus('error');
  const pausedTasks = getTasksByStatus('paused');
  const activeTasks = getTasksByStatus('active');

  const recentFailures = errorTasks.slice(0, 20).map((task) => {
    const recentRuns = getRecentTaskRuns(task.id, 5);
    const diagnosis = diagnoseTaskFailure(task, recentRuns, task.last_error || 'Unknown');
    return {
      taskId: task.id,
      prompt: task.prompt.slice(0, 100),
      failCount: task.retry_count,
      lastError: task.last_error || 'Unknown',
      diagnosis,
    };
  });

  return {
    totalTasks: allTasks.length,
    activeTasks: activeTasks.length,
    pausedTasks: pausedTasks.length,
    errorTasks: errorTasks.length,
    recentFailures,
  };
}

/**
 * Handle task failure: diagnose, auto-recover, notify owner if needed.
 * Schedules retries via setTimeout (non-blocking).
 */
async function handleTaskFailure(
  task: ScheduledTask,
  error: string,
  deps: SchedulerDependencies,
): Promise<void> {
  const retryCount = incrementTaskRetryCount(task.id, error);
  const recentRuns = getRecentTaskRuns(task.id, 10);
  const diagnosis = diagnoseTaskFailure(task, recentRuns, error);

  logger.info(
    { taskId: task.id, retryCount, pattern: diagnosis.pattern, recommendation: diagnosis.recommendation },
    'Task failure diagnosed',
  );

  // Auto-recovery based on diagnosis
  switch (diagnosis.pattern) {
    case 'orphaned': {
      updateTaskStatus(task.id, 'completed');
      const msg = formatFailureNotification(task, diagnosis, error, 'completed');
      await deps.sendMessage(task.chat_jid, msg).catch((e) =>
        logger.error({ err: e, taskId: task.id }, 'Failed to send failure notification'),
      );
      return;
    }

    case 'persistent': {
      updateTaskStatus(task.id, 'paused');
      const msg = formatFailureNotification(task, diagnosis, error, 'paused');
      await deps.sendMessage(task.chat_jid, msg).catch((e) =>
        logger.error({ err: e, taskId: task.id }, 'Failed to send failure notification'),
      );
      return;
    }

    case 'rate-limited': {
      // Use longer backoff for rate limits — always use max delay
      if (retryCount <= (task.max_retries || 3)) {
        const delay = RETRY_DELAYS[RETRY_DELAYS.length - 1];
        logger.info({ taskId: task.id, delayMs: delay }, 'Scheduling rate-limit retry');
        scheduleRetry(task, delay, deps);
      } else {
        updateTaskStatus(task.id, 'error');
        const msg = formatFailureNotification(task, diagnosis, error, 'error');
        await deps.sendMessage(task.chat_jid, msg).catch((e) =>
          logger.error({ err: e, taskId: task.id }, 'Failed to send failure notification'),
        );
      }
      return;
    }

    default:
      break;
  }

  // Standard retry with exponential backoff
  const maxRetries = task.max_retries || 3;
  if (retryCount <= maxRetries) {
    const delayIndex = Math.min(retryCount - 1, RETRY_DELAYS.length - 1);
    const delay = RETRY_DELAYS[delayIndex];
    logger.info({ taskId: task.id, retryCount, delayMs: delay }, 'Scheduling retry');
    scheduleRetry(task, delay, deps);
  } else {
    // Exhausted retries
    updateTaskStatus(task.id, 'error');
    const msg = formatFailureNotification(task, diagnosis, error, 'error');
    await deps.sendMessage(task.chat_jid, msg).catch((e) =>
      logger.error({ err: e, taskId: task.id }, 'Failed to send failure notification'),
    );
  }
}

/**
 * Schedule a retry via setTimeout (non-blocking).
 */
function scheduleRetry(
  task: ScheduledTask,
  delayMs: number,
  deps: SchedulerDependencies,
): void {
  setTimeout(() => {
    // Re-check task status — may have been paused/cancelled while waiting
    const currentTask = getTaskById(task.id);
    if (!currentTask || (currentTask.status !== 'active' && currentTask.status !== 'error')) {
      logger.info({ taskId: task.id }, 'Retry skipped — task no longer active');
      return;
    }

    deps.queue.enqueueTask(
      currentTask.chat_jid,
      currentTask.id,
      () => runTask(currentTask, deps),
    );
  }, delayMs);
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    const error = `Group not found: ${task.group_folder}`;
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    await handleTaskFailure(task, error, deps);
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Scheduled task idle timeout, closing container stdin');
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // Handle failure with retry/diagnosis/notification
  if (error) {
    await handleTaskFailure(task, error, deps);
    // Still compute next_run for the regular schedule (retry is separate)
  } else {
    // Success — reset retry count
    resetTaskRetryCount(task.id);
  }

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
