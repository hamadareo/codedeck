/**
 * Status hooks (docs/phase2-plan.md). Passed to claude with `--settings <file>`
 * for CodeDeck's launches only; the profile's own settings files are never edited.
 *
 * Each hook appends one word to $CODEDECK_STATUS_FILE: never the prompt, the
 * output, or the hook's JSON input (§8).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HookWord } from '@shared/status';

export const STATUS_FILE_ENV = 'CODEDECK_STATUS_FILE';

interface CommandHook {
  type: 'command';
  command: string;
  shell?: 'bash' | 'powershell';
  async: true;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

export interface HookSettings {
  hooks: Record<string, HookGroup[]>;
}

/** The hook command for one word. Windows uses PowerShell (always present; Git Bash may not be). */
export function hookCommand(word: HookWord, platform: NodeJS.Platform): CommandHook {
  if (platform === 'win32') {
    return {
      type: 'command',
      shell: 'powershell',
      command: `Add-Content -LiteralPath $env:${STATUS_FILE_ENV} -Value '${word}'`,
      async: true,
      timeout: 15,
    };
  }
  return {
    type: 'command',
    command: `printf '%s\\n' '${word}' >> "$${STATUS_FILE_ENV}"`,
    async: true,
    timeout: 15,
  };
}

export function buildHookSettings(platform: NodeJS.Platform = process.platform): HookSettings {
  const group = (word: HookWord, matcher?: string): HookGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [hookCommand(word, platform)],
  });
  return {
    hooks: {
      SessionStart: [group('start')],
      UserPromptSubmit: [group('prompt')],
      Stop: [group('stop')],
      StopFailure: [group('failure')],
      Notification: [
        group('permission', 'permission_prompt|elicitation_dialog'),
        group('idle', 'idle_prompt'),
      ],
    },
  };
}

/** Write the settings file once per app start (it is the same for every session). */
export function writeHookSettings(dir: string, platform: NodeJS.Platform = process.platform): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'codedeck-hooks.json');
  fs.writeFileSync(file, JSON.stringify(buildHookSettings(platform), null, 2));
  return file;
}
