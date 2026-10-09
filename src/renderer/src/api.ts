import type { CodeDeckApi } from '@shared/ipc';

export const api: CodeDeckApi = window.codedeck;

/** Main-process errors arrive as "Error invoking remote method 'x': Error: <message>". */
export function errorKey(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /Error: ([^\n]*)$/.exec(msg);
  return (m?.[1] ?? msg).trim();
}
