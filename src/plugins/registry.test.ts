import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PluginRegistry } from './registry.js';
import { PluginEventBus } from './events.js';
import type { ContextServices } from './context.js';

function makeServices(): ContextServices {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    events: new PluginEventBus(),
    ipc: { writeFile: vi.fn(() => 'test.json'), readFile: vi.fn(() => '{}') },
    messages: { send: vi.fn(), sendVoice: vi.fn() },
    tasks: { schedule: vi.fn(() => ''), list: vi.fn(() => []), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
  };
}

describe('PluginRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-plugin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createPlugin(name: string, manifest: object, code: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.mjs'), code);
    return dir;
  }

  it('should discover plugins from directory', () => {
    createPlugin('test-plugin', {
      name: 'test-plugin', version: '1.0.0', description: 'Test',
      target: 'host', capabilities: [], main: 'index.mjs',
    }, 'export default { manifest: undefined };');

    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services: makeServices(),
    });

    const discovered = registry.discover();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].manifest.name).toBe('test-plugin');
  });

  it('should filter by target', () => {
    createPlugin('host-only', {
      name: 'host-only', version: '1.0.0', description: 'Host',
      target: 'host', main: 'index.mjs',
    }, 'export default { manifest: undefined };');
    createPlugin('container-only', {
      name: 'container-only', version: '1.0.0', description: 'Container',
      target: 'container', main: 'index.mjs',
    }, 'export default { manifest: undefined };');

    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services: makeServices(),
    });

    const discovered = registry.discover();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].manifest.name).toBe('host-only');
  });

  it('should load plugins with "both" target', () => {
    createPlugin('both-plugin', {
      name: 'both-plugin', version: '1.0.0', description: 'Both',
      target: 'both', main: 'index.mjs',
    }, 'export default { manifest: undefined };');

    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'container',
      services: makeServices(),
    });

    expect(registry.discover()).toHaveLength(1);
  });

  it('should skip invalid manifests', () => {
    const dir = path.join(tmpDir, 'bad');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{ invalid json');

    const services = makeServices();
    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services,
    });

    expect(registry.discover()).toHaveLength(0);
    expect(services.logger.warn).toHaveBeenCalled();
  });

  it('should resolve dependencies in topological order', () => {
    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services: makeServices(),
    });

    const plugins = [
      { manifest: { name: 'b', version: '1', description: '', target: 'host' as const, capabilities: [], dependencies: ['a'], main: 'index.mjs' }, dir: '' },
      { manifest: { name: 'a', version: '1', description: '', target: 'host' as const, capabilities: [], dependencies: [], main: 'index.mjs' }, dir: '' },
    ];

    const sorted = registry.topologicalSort(plugins);
    expect(sorted.map((p) => p.manifest.name)).toEqual(['a', 'b']);
  });

  it('should detect circular dependencies', () => {
    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services: makeServices(),
    });

    const plugins = [
      { manifest: { name: 'a', version: '1', description: '', target: 'host' as const, capabilities: [], dependencies: ['b'], main: '' }, dir: '' },
      { manifest: { name: 'b', version: '1', description: '', target: 'host' as const, capabilities: [], dependencies: ['a'], main: '' }, dir: '' },
    ];

    expect(() => registry.topologicalSort(plugins)).toThrow(/[Cc]ircular/);
  });

  it('should load and unload plugins', async () => {
    createPlugin('loadable', {
      name: 'loadable', version: '1.0.0', description: 'Loadable',
      target: 'host', main: 'index.mjs',
    }, `
      const plugin = {
        manifest: undefined,
        onLoad: async () => {},
        onUnload: async () => {},
      };
      export default plugin;
    `);

    const services = makeServices();
    const registry = new PluginRegistry({
      pluginDirs: [tmpDir],
      target: 'host',
      services,
    });

    await registry.loadAll();
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('loadable')).toBeDefined();

    await registry.unloadAll();
    expect(registry.getAll()).toHaveLength(0);
  });

  it('should skip non-existent plugin directories', () => {
    const registry = new PluginRegistry({
      pluginDirs: ['/non/existent/path'],
      target: 'host',
      services: makeServices(),
    });

    expect(registry.discover()).toHaveLength(0);
  });
});
