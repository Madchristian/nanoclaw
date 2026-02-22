/**
 * Plugin Registry
 * Discovers, validates, loads, and manages plugins.
 */

import fs from 'fs';
import path from 'path';

import { PluginEventBus } from './events.js';
import { createPluginContext, type ContextServices } from './context.js';
import type { Plugin, PluginManifest, PluginModule } from './types.js';
import { PluginManifestSchema } from './types.js';

export interface RegistryOptions {
  /** Directories to scan for plugin folders */
  pluginDirs: string[];
  /** Only load plugins matching this target */
  target: 'host' | 'container';
  /** Services for context injection */
  services: ContextServices;
}

interface LoadedPlugin {
  plugin: Plugin;
  manifest: PluginManifest;
  dir: string;
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private loadOrder: string[] = [];
  private options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /** Discover and load all plugins from configured directories. */
  async loadAll(): Promise<void> {
    const discovered = this.discover();
    const sorted = this.topologicalSort(discovered);

    for (const { manifest, dir } of sorted) {
      await this.loadPlugin(manifest, dir);
    }
  }

  /** Load a single plugin by manifest and directory. */
  async loadPlugin(manifest: PluginManifest, dir: string): Promise<void> {
    if (this.plugins.has(manifest.name)) {
      this.options.services.logger.warn(`Plugin "${manifest.name}" already loaded, skipping`);
      return;
    }

    const entryPoint = path.resolve(dir, manifest.main);
    // Security: ensure resolved path stays within plugin directory
    if (!entryPoint.startsWith(path.resolve(dir) + path.sep) && entryPoint !== path.resolve(dir)) {
      throw new Error(`Plugin "${manifest.name}": entry point escapes plugin directory: ${manifest.main}`);
    }
    if (!fs.existsSync(entryPoint)) {
      throw new Error(`Plugin "${manifest.name}": entry point not found: ${manifest.main}`);
    }

    const mod = await import(entryPoint) as PluginModule;
    const plugin = mod.default;

    if (!plugin) {
      throw new Error(`Plugin "${manifest.name}": no default export`);
    }

    plugin.manifest = manifest;

    // Create capability-gated context
    const ctx = createPluginContext(manifest, this.options.services);

    if (plugin.onLoad) {
      const LOAD_TIMEOUT_MS = 30_000;
      await Promise.race([
        plugin.onLoad(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Plugin "${manifest.name}" onLoad() timed out after ${LOAD_TIMEOUT_MS}ms`,
          )), LOAD_TIMEOUT_MS),
        ),
      ]);
    }

    this.plugins.set(manifest.name, { plugin, manifest, dir });
    this.loadOrder.push(manifest.name);
    this.options.services.events.emit('plugin:loaded', { name: manifest.name });
    this.options.services.logger.info(`Plugin loaded: ${manifest.name} v${manifest.version}`);
  }

  /** Unload all plugins in reverse order. */
  async unloadAll(): Promise<void> {
    for (const name of [...this.loadOrder].reverse()) {
      await this.unloadPlugin(name);
    }
  }

  /** Unload a single plugin. */
  async unloadPlugin(name: string): Promise<void> {
    const loaded = this.plugins.get(name);
    if (!loaded) return;

    if (loaded.plugin.onUnload) {
      const UNLOAD_TIMEOUT_MS = 10_000;
      await Promise.race([
        loaded.plugin.onUnload(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Plugin "${name}" onUnload() timed out after ${UNLOAD_TIMEOUT_MS}ms`,
          )), UNLOAD_TIMEOUT_MS),
        ),
      ]).catch((err) => {
        this.options.services.logger.warn(
          `Plugin "${name}" unload error (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    this.plugins.delete(name);
    this.loadOrder = this.loadOrder.filter((n) => n !== name);
    this.options.services.events.emit('plugin:unloaded', { name });
    this.options.services.logger.info(`Plugin unloaded: ${name}`);
  }

  /** Get a loaded plugin by name. */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  /** Get all loaded plugins in load order. */
  getAll(): Plugin[] {
    return this.loadOrder.map((n) => this.plugins.get(n)!.plugin);
  }

  /** Get all loaded plugins that have MCP tool definitions. */
  getToolPlugins(): Plugin[] {
    return this.getAll().filter((p) => p.tools && p.tools.length > 0);
  }

  // --- Discovery ---

  /** Scan plugin directories for valid plugin manifests. */
  discover(): Array<{ manifest: PluginManifest; dir: string }> {
    const results: Array<{ manifest: PluginManifest; dir: string }> = [];

    for (const baseDir of this.options.pluginDirs) {
      if (!fs.existsSync(baseDir)) continue;

      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(baseDir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (!fs.existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const manifest = PluginManifestSchema.parse(raw);

          // Filter by target
          if (manifest.target !== 'both' && manifest.target !== this.options.target) {
            continue;
          }

          results.push({ manifest, dir: pluginDir });
        } catch (err) {
          this.options.services.logger.warn(
            `Invalid plugin manifest in ${entry.name}/: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return results;
  }

  // --- Dependency resolution ---

  /** Topological sort of plugins by dependencies. Throws on cycles. */
  topologicalSort(
    plugins: Array<{ manifest: PluginManifest; dir: string }>,
  ): Array<{ manifest: PluginManifest; dir: string }> {
    const byName = new Map(plugins.map((p) => [p.manifest.name, p]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: Array<{ manifest: PluginManifest; dir: string }> = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular plugin dependency detected involving "${name}"`);
      }

      const entry = byName.get(name);
      if (!entry) return; // External dependency, skip

      visiting.add(name);
      for (const dep of entry.manifest.dependencies) {
        visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      sorted.push(entry);
    };

    for (const p of plugins) {
      visit(p.manifest.name);
    }

    return sorted;
  }
}
