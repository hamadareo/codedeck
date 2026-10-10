import fs from 'node:fs';
import path from 'node:path';

/** The encryption half of Electron's safeStorage (injected so tests run without Electron). */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

/**
 * The Discord bot token, encrypted with the OS keychain via safeStorage
 * (macOS Keychain / Windows DPAPI) (§6). Never written in plain text, never
 * sent to the renderer, never logged.
 */
export class SecretStore {
  constructor(
    private readonly dir: string,
    private readonly cipher: Cipher,
  ) {}

  private get file(): string {
    return path.join(this.dir, 'discord-token.bin');
  }

  available(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  has(): boolean {
    return fs.existsSync(this.file);
  }

  set(token: string): void {
    const t = token.trim();
    if (!t) throw new Error('discord.error.tokenEmpty');
    if (!this.available()) throw new Error('discord.error.noKeychain');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, this.cipher.encryptString(t), { mode: 0o600 });
  }

  get(): string | null {
    if (!this.has() || !this.available()) return null;
    try {
      return this.cipher.decryptString(fs.readFileSync(this.file));
    } catch {
      return null;
    }
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
