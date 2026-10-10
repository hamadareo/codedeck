import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDir, PREVIEW_BYTES, previewFile, resolveInside } from '../../src/main/files';

let root = '';
let outside = '';
let profileDir = '';

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd files テスト '));
  root = path.join(tmp, 'my project');
  outside = path.join(tmp, 'outside');
  profileDir = path.join(root, '.codedeck-profile');
  for (const d of [root, outside, path.join(root, 'src'), path.join(root, '.git'), profileDir])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'file10.txt'), 'ten');
  fs.writeFileSync(path.join(root, 'file2.txt'), 'two');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
  fs.writeFileSync(path.join(profileDir, '.credentials.json'), '{"secret":"x"}');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
});

afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

describe('file explorer', () => {
  it('lists folders first, in natural order; .git and protected folders are left out', () => {
    const { entries, more } = listDir(root, '', [profileDir]);
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:src',
      'file:file2.txt',
      'file:file10.txt',
    ]);
    expect(more).toBe(0);
    expect(entries.find((e) => e.name === 'file2.txt')!.size).toBe(3);
    expect(listDir(root, 'src', [profileDir]).entries[0]).toMatchObject({ path: 'src/app.ts', kind: 'file' });
  });

  it('never leaves the folder, and never opens a profile config dir (credentials)', () => {
    expect(() => resolveInside(root, '../outside/secret.txt', [])).toThrow('files.error.outside');
    expect(() => resolveInside(root, path.join(outside, 'secret.txt'), [])).toThrow('files.error.outside');
    expect(() => previewFile(root, '.codedeck-profile/.credentials.json', [profileDir])).toThrow(
      'files.error.protected',
    );
    expect(() => listDir(root, '.codedeck-profile', [profileDir])).toThrow('files.error.protected');
  });

  it.skipIf(process.platform === 'win32')('a link that points outside is refused', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    expect(() => previewFile(root, 'link.txt', [])).toThrow('files.error.outside');
  });

  it('previews text (the beginning of big files) and recognizes binary files', () => {
    expect(previewFile(root, 'src/app.ts', [])).toEqual({
      kind: 'text',
      text: 'export const a = 1;\n',
      size: 20,
      truncated: false,
    });
    fs.writeFileSync(path.join(root, 'big.log'), 'x'.repeat(PREVIEW_BYTES + 10));
    const big = previewFile(root, 'big.log', []);
    expect(big).toMatchObject({ kind: 'text', truncated: true, size: PREVIEW_BYTES + 10 });
    fs.writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect(previewFile(root, 'img.png', [])).toEqual({ kind: 'binary', size: 7 });
    expect(() => previewFile(root, 'src', [])).toThrow('files.error.notFile');
  });
});
