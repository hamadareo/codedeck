/**
 * Status hooks (docs/phase2-plan.md). Passed to claude with `--settings <file>`
 * for CodeDeck's launches only; the profile's own settings files are never edited.
 *
 * Each hook appends one word to $CODEDECK_STATUS_FILE: never the prompt, the
 * output, or the hook's JSON input (§8). The one exception is SessionStart, which
 * also writes the conversation id (a UUID, matched out of its input: nothing else is
 * kept) so a conversation picked with `claude --resume` or /resume is resumed later.
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

/** SessionStart: "start", then "session <uuid>" with the conversation id from the hook input. */
export function sessionStartHook(platform: NodeJS.Platform): CommandHook {
  if (platform === 'win32') {
    return {
      type: 'command',
      shell: 'powershell',
      command:
        `$i = [Console]::In.ReadToEnd(); $s = ''; ` +
        `if ($i -match '"session_id"\\s*:\\s*"([0-9a-fA-F-]{36})"') { $s = $Matches[1] }; ` +
        `Add-Content -LiteralPath $env:${STATUS_FILE_ENV} -Value @('start', "session $s")`,
      async: true,
      timeout: 15,
    };
  }
  return {
    type: 'command',
    command:
      `s=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F-]\\{36\\}\\)".*/\\1/p' | head -n 1); ` +
      `printf 'start\\nsession %s\\n' "$s" >> "$${STATUS_FILE_ENV}"`,
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
      SessionStart: [{ hooks: [sessionStartHook(platform)] }],
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
