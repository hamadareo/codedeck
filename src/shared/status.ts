/**
 * Session status (§4). Hooks report what claude is doing (Activity); the PTY
 * state and the session's location decide the rest. Pure, shared, tested.
 */
import type { Activity, PtyState, Session, SessionStatus } from './types';

/** Words CodeDeck's hooks append to the status file (one per line, nothing else). */
export type HookWord = 'start' | 'prompt' | 'stop' | 'failure' | 'permission' | 'idle';
export const HOOK_WORDS: readonly HookWord[] = ['start', 'prompt', 'stop', 'failure', 'permission', 'idle'];

/** Events that move a session's Activity. */
export type ActivityEvent = HookWord | 'input' | 'seen' | 'reset';

export function nextActivity(prev: Activity, ev: ActivityEvent): Activity {
  switch (ev) {
    case 'reset':
      return 'unknown';
    case 'start':
      // SessionStart also fires after /clear and /compact; it never interrupts an approval.
      return prev === 'approval' ? prev : 'waiting';
    case 'prompt':
      return 'working';
    case 'stop':
      return 'done';
    case 'failure':
      return 'error';
    case 'permission':
      return 'approval';
    case 'idle':
      // idle_prompt: claude has been waiting for input; a finished turn not yet seen stays "done".
      return prev === 'done' || prev === 'error' || prev === 'limit' ? prev : 'waiting';
    case 'input':
      // The user answered the approval prompt in the terminal.
      return prev === 'approval' ? 'working' : prev;
    case 'seen':
      return prev === 'done' ? 'waiting' : prev;
  }
}

export function displayStatus(
  session: Pick<Session, 'location'>,
  pty: PtyState,
  activity: Activity,
  exitCode: number | null = null,
): SessionStatus {
  if (session.location === 'external') return 'external';
  if (pty === 'idle') return 'idle';
  if (pty === 'exited') return exitCode !== null && exitCode !== 0 ? 'error' : 'exited';
  return activity === 'unknown' ? 'running' : activity;
}

/** Statuses that need the user's attention (badges, notifications in Phase 3). */
export function needsAttention(s: SessionStatus): boolean {
  return s === 'approval' || s === 'done' || s === 'error' || s === 'limit';
}

/** Icon + color token per status: never color alone (§4). */
export const STATUS_STYLE: Record<
  SessionStatus,
  { icon: string; tone: 'muted' | 'ok' | 'accent' | 'warn' | 'danger' }
> = {
  idle: { icon: '○', tone: 'muted' },
  starting: { icon: '◌', tone: 'muted' },
  running: { icon: '▶', tone: 'ok' },
  working: { icon: '◐', tone: 'accent' },
  waiting: { icon: '⌨', tone: 'ok' },
  approval: { icon: '⚠', tone: 'warn' },
  done: { icon: '✓', tone: 'ok' },
  error: { icon: '✕', tone: 'danger' },
  limit: { icon: '⏸', tone: 'danger' },
  exited: { icon: '■', tone: 'muted' },
  external: { icon: '↗', tone: 'accent' },
};
