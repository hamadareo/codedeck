import os from 'node:os';
import path from 'node:path';

/** Default config dir for a profile: ~/.codedeck/profiles/<name> (§2.5). */
export function defaultProfileDir(name: string, home: string = os.homedir()): string {
  return path.join(home, '.codedeck', 'profiles', name.trim());
}

/** The CLI's own default config dir, used to tell users which login is "theirs". */
export function claudeDefaultDir(home: string = os.homedir()): string {
  return path.join(home, '.claude');
}
