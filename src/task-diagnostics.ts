import { ScheduledTask, TaskRunLog } from './types.js';

export interface TaskDiagnosis {
  pattern: 'persistent' | 'timeout' | 'orphaned' | 'rate-limited' | 'transient' | 'unknown';
  description: string;
  recommendation: 'retry' | 'pause' | 'deactivate' | 'notify' | 'increase-timeout';
  details?: string;
}

/**
 * Analyze task failure patterns and return a diagnosis.
 */
export function diagnoseTaskFailure(
  _task: ScheduledTask,
  recentRuns: TaskRunLog[],
  currentError: string,
): TaskDiagnosis {
  const lowerError = currentError.toLowerCase();

  // Orphaned: group/chat not found
  if (lowerError.includes('group not found') || lowerError.includes('not found')) {
    if (lowerError.includes('group not found') || lowerError.includes('chat not found')) {
      return {
        pattern: 'orphaned',
        description: 'Gruppe oder Chat nicht mehr erreichbar',
        recommendation: 'deactivate',
        details: currentError,
      };
    }
  }

  // Rate limit / API errors
  if (
    lowerError.includes('rate limit') ||
    lowerError.includes('429') ||
    lowerError.includes('too many requests') ||
    lowerError.includes('api error')
  ) {
    return {
      pattern: 'rate-limited',
      description: 'API Rate-Limit erreicht',
      recommendation: 'retry',
      details: currentError,
    };
  }

  // Timeout
  if (
    lowerError.includes('timeout') ||
    lowerError.includes('timed out') ||
    lowerError.includes('idle timeout')
  ) {
    return {
      pattern: 'timeout',
      description: 'Container-Timeout überschritten',
      recommendation: 'increase-timeout',
      details: currentError,
    };
  }

  // Check for persistent failure: same error repeated in recent runs
  const recentErrors = recentRuns
    .filter((r) => r.status === 'error' && r.error)
    .map((r) => r.error!);

  if (recentErrors.length >= 2) {
    // Normalize errors for comparison (first 100 chars)
    const normalize = (e: string) => e.slice(0, 100).toLowerCase().trim();
    const currentNorm = normalize(currentError);
    const sameErrorCount = recentErrors.filter(
      (e) => normalize(e) === currentNorm,
    ).length;

    if (sameErrorCount >= 2) {
      return {
        pattern: 'persistent',
        description: `Persistenter Fehler (${sameErrorCount + 1}x wiederholt)`,
        recommendation: 'pause',
        details: currentError,
      };
    }

    // Different errors = transient
    return {
      pattern: 'transient',
      description: 'Unterschiedliche Fehler — möglicherweise vorübergehend',
      recommendation: 'retry',
      details: currentError,
    };
  }

  return {
    pattern: 'unknown',
    description: 'Unbekannter Fehler',
    recommendation: 'retry',
    details: currentError,
  };
}

const RECOMMENDATION_LABELS: Record<TaskDiagnosis['recommendation'], string> = {
  retry: 'Erneut versuchen',
  pause: 'Task pausieren',
  deactivate: 'Task deaktivieren',
  notify: 'Owner benachrichtigen',
  'increase-timeout': 'Timeout erhöhen',
};

const ACTION_LABELS: Record<string, string> = {
  paused: 'pausiert',
  completed: 'deaktiviert',
  error: 'auf Fehler-Status gesetzt',
};

/**
 * Format a notification message for the task owner.
 */
export function formatFailureNotification(
  task: ScheduledTask,
  diagnosis: TaskDiagnosis,
  error: string,
  action: string,
): string {
  const promptPreview = task.prompt.length > 60
    ? task.prompt.slice(0, 57) + '...'
    : task.prompt;
  const actionLabel = ACTION_LABELS[action] || action;

  return [
    `⚠️ Task "${promptPreview}" fehlgeschlagen`,
    '',
    `Diagnose: ${diagnosis.description}`,
    `Empfehlung: ${RECOMMENDATION_LABELS[diagnosis.recommendation]}`,
    `Fehler: ${error}`,
    '',
    `Task wurde ${actionLabel}. Nutze resume_task/schedule_task um fortzufahren.`,
  ].join('\n');
}
