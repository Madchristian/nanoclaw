/**
 * Plugin Context & Dependency Injection
 * Creates capability-gated contexts for plugins.
 */

import type {
  Capability,
  EventBus,
  IpcService,
  Logger,
  MessageService,
  PluginContext,
  PluginManifest,
  TaskService,
  ToolContext,
} from './types.js';

function denied(service: string, capability: Capability): never {
  throw new Error(`Plugin lacks "${capability}" capability required for ${service}`);
}

/** Creates a no-op proxy that throws on any property access with a clear error. */
function blockedService<T extends object>(service: string, capability: Capability): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return () => denied(service, capability);
    },
  });
}

export interface ContextServices {
  logger: Logger;
  events: EventBus;
  ipc: IpcService;
  messages: MessageService;
  tasks: TaskService;
}

/**
 * Build a PluginContext with only the services the plugin's capabilities allow.
 */
export function createPluginContext(
  manifest: PluginManifest,
  services: ContextServices,
  config?: Record<string, unknown>,
): PluginContext {
  const caps = new Set(manifest.capabilities);

  return {
    logger: services.logger,
    events: services.events,
    config: config ?? {},
    ipc: (() => {
      if (caps.has('ipc:read') && caps.has('ipc:write')) return services.ipc;
      if (caps.has('ipc:read') || caps.has('ipc:write')) {
        // Granular: only expose allowed operations
        return new Proxy(services.ipc, {
          get(target, prop) {
            if (prop === 'writeFile' && !caps.has('ipc:write')) return () => denied('ipc.writeFile', 'ipc:write');
            if (prop === 'readFile' && !caps.has('ipc:read')) return () => denied('ipc.readFile', 'ipc:read');
            return (target as unknown as Record<string | symbol, unknown>)[prop];
          },
        });
      }
      return blockedService<IpcService>('ipc', 'ipc:read');
    })(),
    messages: (caps.has('messages:read') || caps.has('messages:write'))
      ? services.messages
      : blockedService<MessageService>('messages', 'messages:write'),
    tasks: caps.has('tasks:manage')
      ? services.tasks
      : blockedService<TaskService>('tasks', 'tasks:manage'),
  };
}

/**
 * Extend a PluginContext into a ToolContext with runtime info.
 */
export function createToolContext(
  base: PluginContext,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): ToolContext {
  return { ...base, chatJid, groupFolder, isMain };
}
