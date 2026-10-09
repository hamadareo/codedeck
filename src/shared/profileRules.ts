import type { Profile, ProfileKind, Project } from './types';

/** Initial colors per kind (§4: personal = blue, team = green). User can change them. */
export const DEFAULT_COLORS: Record<ProfileKind, string> = {
  personal: '#2563eb',
  team: '#16a34a',
  other: '#9333ea',
};

export const PROFILE_NAME_MAX = 40;

/** Black or white, whichever has the higher contrast on the given #rrggbb (WCAG relative luminance). */
export function readableTextColor(hex: string): '#000000' | '#ffffff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // contrast with white = 1.05 / (L + 0.05); with black = (L + 0.05) / 0.05
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

/** Names become directory names, so keep them filesystem-safe on both OSes. */
export function validateProfileName(name: string, existing: Pick<Profile, 'name'>[]): string | null {
  const n = name.trim();
  if (!n) return 'profile.error.nameRequired';
  if (n.length > PROFILE_NAME_MAX) return 'profile.error.nameTooLong';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) {
    return 'profile.error.nameInvalid';
  }
  if (existing.some((p) => p.name.toLowerCase() === n.toLowerCase())) return 'profile.error.nameTaken';
  return null;
}

/** The profile a new session in this project should start with. */
export function defaultProfileFor(project: Project | null, profiles: Profile[]): Profile | null {
  if (project?.pinnedProfileId) {
    const pinned = profiles.find((p) => p.id === project.pinnedProfileId);
    if (pinned) return pinned;
  }
  return profiles[0] ?? null;
}

/** §3-5: starting a session with a profile other than the project's pin needs confirmation. */
export function needsProfileConfirm(project: Project | null, profileId: string): boolean {
  return !!project?.pinnedProfileId && project.pinnedProfileId !== profileId;
}
