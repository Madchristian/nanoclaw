import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import {
  findResolutionDir,
  saveResolution,
} from '../resolution-cache.js';
import { createTempDir, setupNanoclawDir, cleanup } from './test-helpers.js';

describe('resolution-cache', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('findResolutionDir returns null when not found', () => {
    const result = findResolutionDir(['skill-a', 'skill-b'], tmpDir);
    expect(result).toBeNull();
  });

  it('saveResolution creates directory structure with files and meta', () => {
    saveResolution(
      ['skill-b', 'skill-a'],
      [{ relPath: 'src/config.ts', preimage: 'conflict content', resolution: 'resolved content' }],
      { core_version: '1.0.0' },
      tmpDir,
    );

    // Skills are sorted, so key is "skill-a+skill-b"
    const resDir = path.join(tmpDir, '.nanoclaw', 'resolutions', 'skill-a+skill-b');
    expect(fs.existsSync(resDir)).toBe(true);

    // Check preimage and resolution files exist
    expect(fs.existsSync(path.join(resDir, 'src/config.ts.preimage'))).toBe(true);
    expect(fs.existsSync(path.join(resDir, 'src/config.ts.resolution'))).toBe(true);

    // Check meta.yaml exists and has expected fields
    const metaPath = path.join(resDir, 'meta.yaml');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.core_version).toBe('1.0.0');
    expect(meta.skills).toEqual(['skill-a', 'skill-b']);
  });

  it('findResolutionDir returns path after save', () => {
    saveResolution(
      ['alpha', 'beta'],
      [{ relPath: 'file.ts', preimage: 'pre', resolution: 'post' }],
      {},
      tmpDir,
    );

    const result = findResolutionDir(['alpha', 'beta'], tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('alpha+beta');
  });

  it('findResolutionDir finds shipped resolutions in .claude/resolutions', () => {
    const shippedDir = path.join(tmpDir, '.claude', 'resolutions', 'alpha+beta');
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, 'meta.yaml'), 'skills: [alpha, beta]\n');

    const result = findResolutionDir(['alpha', 'beta'], tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('.claude/resolutions/alpha+beta');
  });

  it('findResolutionDir prefers shipped over project-level', () => {
    // Create both shipped and project-level
    const shippedDir = path.join(tmpDir, '.claude', 'resolutions', 'a+b');
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, 'meta.yaml'), 'skills: [a, b]\n');

    saveResolution(
      ['a', 'b'],
      [{ relPath: 'f.ts', preimage: 'x', resolution: 'project' }],
      {},
      tmpDir,
    );

    const result = findResolutionDir(['a', 'b'], tmpDir);
    expect(result).toContain('.claude/resolutions/a+b');
  });

  it('skills are sorted so order does not matter', () => {
    saveResolution(
      ['zeta', 'alpha'],
      [{ relPath: 'f.ts', preimage: 'a', resolution: 'b' }],
      {},
      tmpDir,
    );

    // Find with reversed order should still work
    const result = findResolutionDir(['alpha', 'zeta'], tmpDir);
    expect(result).not.toBeNull();

    // Also works with original order
    const result2 = findResolutionDir(['zeta', 'alpha'], tmpDir);
    expect(result2).not.toBeNull();
    expect(result).toBe(result2);
  });
});
