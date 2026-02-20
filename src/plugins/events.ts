/**
 * Typed Event Bus — simple EventEmitter without external dependencies.
 * Handlers run in parallel with a per-handler timeout to prevent DoS.
 */

import type { EventBus, EventMap } from './types.js';

type Handler<T> = (data: T) => void;

/** Default timeout for each handler (ms). */
const HANDLER_TIMEOUT_MS = 5000;

export class PluginEventBus implements EventBus {
  private handlers = new Map<string, Set<Handler<unknown>>>();
  private handlerTimeoutMs: number;

  constructor(opts?: { handlerTimeoutMs?: number }) {
    this.handlerTimeoutMs = opts?.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
  }

  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(handler as Handler<unknown>);
  }

  off<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
    const set = this.handlers.get(event as string);
    if (set) {
      set.delete(handler as Handler<unknown>);
      if (set.size === 0) this.handlers.delete(event as string);
    }
  }

  async emit<K extends keyof EventMap>(event: K, data: EventMap[K]): Promise<void> {
    const set = this.handlers.get(event as string);
    if (!set) return;

    const timeoutMs = this.handlerTimeoutMs;

    const promises = [...set].map((handler) =>
      Promise.race([
        Promise.resolve().then(() => handler(data)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Handler timeout (${timeoutMs}ms)`)), timeoutMs),
        ),
      ]).catch((err) => {
        console.error(`[EventBus] Handler for "${event as string}" failed:`, err);
      }),
    );

    await Promise.allSettled(promises);
  }

  /** Remove all handlers (useful for cleanup/tests). */
  clear(): void {
    this.handlers.clear();
  }

  /** Number of handlers for a given event. */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.handlers.get(event as string)?.size ?? 0;
  }
}
