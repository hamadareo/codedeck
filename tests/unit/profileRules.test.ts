import { describe, expect, it } from 'vitest';
import {
  defaultProfileFor,
  needsProfileConfirm,
  readableTextColor,
  validateProfileName,
} from '@shared/profileRules';
import type { Profile, Project } from '@shared/types';

const profile = (id: string, name: string): Profile => ({
  id,
  name,
  kind: 'personal',
  color: '#2563eb',
  icon: '',
  configDir: `/p/${name}`,
  note: '',
  authStatus: 'unknown',
  accountEmail: null,
  sort: 0,
  createdAt: 0,
});
const project = (pinned: string | null): Project => ({
  id: 'pr',
  name: 'app',
  path: '/app',
  pinnedProfileId: pinned,
  createdAt: 0,
});

describe('validateProfileName', () => {
  it('accepts Japanese and spaces', () => {
    expect(validateProfileName('会社 チーム', [])).toBeNull();
  });
  it('rejects empty, duplicates (case-insensitive), path characters and Windows reserved names', () => {
    expect(validateProfileName('  ', [])).toBe('profile.error.nameRequired');
    expect(validateProfileName('Team', [profile('1', 'team')])).toBe('profile.error.nameTaken');
    for (const bad of ['a/b', 'a\\b', 'a:b', 'what?', 'CON', 'nul', 'com1', 'trailing.']) {
      expect(validateProfileName(bad, [])).toBe('profile.error.nameInvalid');
    }
    expect(validateProfileName('x'.repeat(41), [])).toBe('profile.error.nameTooLong');
  });
});

describe('pinning (§3-3, §3-5)', () => {
  const a = profile('a', 'personal');
  const b = profile('b', 'team');

  it('a pinned project starts with its pinned profile', () => {
    expect(defaultProfileFor(project('b'), [a, b])?.id).toBe('b');
  });
  it('falls back to the first profile when nothing (or a deleted profile) is pinned', () => {
    expect(defaultProfileFor(project(null), [a, b])?.id).toBe('a');
    expect(defaultProfileFor(project('gone'), [a, b])?.id).toBe('a');
    expect(defaultProfileFor(null, [])).toBeNull();
  });
  it('regression: a profile different from the pin requires confirmation', () => {
    expect(needsProfileConfirm(project('b'), 'a')).toBe(true);
    expect(needsProfileConfirm(project('b'), 'b')).toBe(false);
    expect(needsProfileConfirm(project(null), 'a')).toBe(false);
    expect(needsProfileConfirm(null, 'a')).toBe(false);
  });
});

describe('readableTextColor', () => {
  it('chooses the higher-contrast text color', () => {
    expect(readableTextColor('#2563eb')).toBe('#ffffff');
    expect(readableTextColor('#facc15')).toBe('#000000');
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(readableTextColor('bad')).toBe('#ffffff');
  });
});
