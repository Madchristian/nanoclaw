/**
 * Plugin System — re-exports
 */

export { PluginEventBus } from './events.js';
export { PluginRegistry, type RegistryOptions } from './registry.js';
export { createPluginContext, createToolContext, type ContextServices } from './context.js';
export type {
  Plugin,
  PluginManifest,
  PluginModule,
  PluginContext,
  ToolContext,
  ToolResult,
  McpToolDefinition,
  Capability,
  EventBus,
  EventMap,
  Logger,
  IpcService,
  MessageService,
  TaskService,
  InboundMessage,
} from './types.js';
export { PluginManifestSchema } from './types.js';
