import { describe, expect, it } from 'vitest';
import { fileReference, fileReferences } from '@shared/fileRef';

describe('file references for claude (@path)', () => {
  it('relative inside the session folder, absolute outside, quoted with spaces', () => {
    expect(fileReference('C:\\work\\app', 'src/main.ts')).toBe('@src/main.ts');
    expect(fileReference('C:\\work\\app', 'C:\\work\\app\\src\\main.ts')).toBe('@src/main.ts');
    // Windows paths compare without case; a sibling folder with the same prefix is outside.
    expect(fileReference('C:\\Work\\App', 'c:\\work\\app\\README.md')).toBe('@README.md');
    expect(fileReference('C:\\work\\app', 'C:\\work\\app2\\x.ts')).toBe('@C:\\work\\app2\\x.ts');
    expect(fileReference('/Users/me/app', '/Users/me/app/docs/a b.md')).toBe('@"docs/a b.md"');
    expect(fileReference('/Users/me/app', '/Users/me/App/x.ts')).toBe('@/Users/me/App/x.ts');
    expect(fileReference('/Users/me/app', '/tmp/shot.png')).toBe('@/tmp/shot.png');
  });

  it('several files at once, with a trailing space to keep typing', () => {
    expect(fileReferences('/p', ['/p/a.ts', '/p/b.ts'])).toBe('@a.ts @b.ts ');
    expect(fileReferences('/p', [])).toBe('');
  });
});
