import fs from 'node:fs';
import path from 'node:path';
import { commandFile, commandSlug } from '@shared/prompts';
import type { Prompt } from '@shared/types';

/** CodeDeck writes only inside this folder of a profile's config dir. */
export const COMMAND_DIR = path.join('commands', 'codedeck');
const MARKER = '<!-- written by CodeDeck: edits here are replaced; change the prompt in CodeDeck -->';

/**
 * Write prompts marked "as command" as Claude Code custom commands
 * (<configDir>/commands/codedeck/<slug>.md, callable as /<slug> in claude).
 * Files CodeDeck wrote before but no longer wants are removed; any other
 * file in that folder (not carrying the marker) is left alone.
 */
export function syncCommands(configDir: string, prompts: Prompt[]): { written: string[]; removed: string[] } {
  const dir = path.join(configDir, COMMAND_DIR);
  const wanted = new Map<string, string>();
  for (const p of prompts.filter((x) => x.asCommand)) {
    let slug = commandSlug(p.name, p.id);
    while (wanted.has(slug)) slug = `${slug}-${p.id.slice(0, 4)}`;
    wanted.set(slug, `${commandFile(p)}\n${MARKER}\n`);
  }
  const written: string[] = [];
  const removed: string[] = [];
  if (wanted.size) fs.mkdirSync(dir, { recursive: true });
  for (const [slug, content] of wanted) {
    const file = path.join(dir, `${slug}.md`);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur !== content) fs.writeFileSync(file, content);
    written.push(slug);
  }
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md') || wanted.has(name.slice(0, -3))) continue;
      const file = path.join(dir, name);
      try {
        if (fs.readFileSync(file, 'utf8').includes(MARKER)) {
          fs.unlinkSync(file);
          removed.push(name.slice(0, -3));
        }
      } catch {
        // unreadable: leave it
      }
    }
  }
  return { written, removed };
}
