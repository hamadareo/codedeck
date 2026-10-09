import fs from 'node:fs';
import path from 'node:path';
import type { ExternalTerminalKind } from './platform/externalTerminal';

export interface Settings {
  externalTerminal: ExternalTerminalKind;
  terminalFontSize: number;
  terminalFontFamily: string;
}

export const DEFAULT_SETTINGS: Settings = {
  externalTerminal: 'auto',
  terminalFontSize: 14,
  terminalFontFamily: '',
};

/** Plain JSON settings next to the database (§2: settings are JSON). */
export class SettingsStore {
  private value: Settings;

  constructor(private readonly file: string) {
    this.value = { ...DEFAULT_SETTINGS, ...this.read() };
  }

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }

  private read(): Partial<Settings> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>;
    } catch {
      return {};
    }
  }
}
