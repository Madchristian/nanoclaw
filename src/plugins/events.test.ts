import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginEventBus } from './events.js';

describe('PluginEventBus', () => {
  let bus: PluginEventBus;

  beforeEach(() => {
    bus = new PluginEventBus({ handlerTimeoutMs: 500 });
  });

  it('should emit and receive events', async () => {
    const handler = vi.fn();
    bus.on('plugin:loaded', handler);
    await bus.emit('plugin:loaded', { name: 'test-plugin' });
    expect(handler).toHaveBeenCalledWith({ name: 'test-plugin' });
  });

  it('should support multiple handlers', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('plugin:loaded', h1);
    bus.on('plugin:loaded', h2);
    await bus.emit('plugin:loaded', { name: 'x' });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('should remove handlers with off()', async () => {
    const handler = vi.fn();
    bus.on('plugin:loaded', handler);
    bus.off('plugin:loaded', handler);
    await bus.emit('plugin:loaded', { name: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not crash if handler throws', async () => {
    bus.on('plugin:loaded', () => { throw new Error('boom'); });
    const handler = vi.fn();
    bus.on('plugin:loaded', handler);
    await bus.emit('plugin:loaded', { name: 'x' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should timeout slow handlers without blocking others', async () => {
    const slowHandler = vi.fn(() => new Promise(() => { /* never resolves */ }));
    const fastHandler = vi.fn();
    bus.on('plugin:loaded', slowHandler as () => void);
    bus.on('plugin:loaded', fastHandler);
    await bus.emit('plugin:loaded', { name: 'x' });
    expect(fastHandler).toHaveBeenCalledOnce();
    expect(slowHandler).toHaveBeenCalledOnce();
  });

  it('should report correct listenerCount', () => {
    expect(bus.listenerCount('plugin:loaded')).toBe(0);
    const h = vi.fn();
    bus.on('plugin:loaded', h);
    expect(bus.listenerCount('plugin:loaded')).toBe(1);
    bus.off('plugin:loaded', h);
    expect(bus.listenerCount('plugin:loaded')).toBe(0);
  });

  it('should clear all handlers', () => {
    bus.on('plugin:loaded', vi.fn());
    bus.on('plugin:unloaded', vi.fn());
    bus.clear();
    expect(bus.listenerCount('plugin:loaded')).toBe(0);
    expect(bus.listenerCount('plugin:unloaded')).toBe(0);
  });

  it('should handle emit with no listeners gracefully', async () => {
    await expect(bus.emit('plugin:loaded', { name: 'x' })).resolves.toBeUndefined();
  });
});
