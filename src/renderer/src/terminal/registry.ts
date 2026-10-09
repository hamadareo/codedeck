import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { decideTerminalKey, pasteDecision, type AppAction, type Platform } from '@shared/keymap';
import { api } from '../api';

/**
 * xterm.js instances live outside React so re-renders and tab switches never
 * lose scrollback. One entry per session id.
 */
interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
}

const entries = new Map<string, Entry>();
let platform: Platform = 'other';
let appActionHandler: (action: AppAction) => void = () => {};

export function setPlatform(p: Platform): void {
  platform = p;
}

export function setAppActionHandler(fn: (action: AppAction) => void): void {
  appActionHandler = fn;
}

// One global stream; each chunk goes to its session's terminal unmodified.
api.on('pty:data', (id, data) => entries.get(id)?.term.write(data));

const FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "SF Mono", "BIZ UDGothic", "MS Gothic", "Osaka-Mono", monospace';

export function getTerminal(id: string): Entry {
  const existing = entries.get(id);
  if (existing) return existing;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: FONT_FAMILY,
    fontSize: 14,
    scrollback: 10_000,
    macOptionIsMeta: true,
    // Windows ConPTY reflows itself; xterm must not reflow on top of it.
    windowsPty: navigator.userAgent.includes('Windows') ? { backend: 'conpty' } : undefined,
    theme: {
      background: '#0b0d12',
      foreground: '#e6e8ee',
      cursor: '#e6e8ee',
      selectionBackground: '#334155',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => api.send('link:open', uri)));
  term.open(host);

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || ev.isComposing || ev.keyCode === 229) return true; // IME composition
    const d = decideTerminalKey(ev, platform, term.hasSelection());
    switch (d.kind) {
      case 'pass':
        return true;
      case 'app':
        ev.preventDefault();
        appActionHandler(d.action);
        return false;
      case 'copy':
        ev.preventDefault();
        api.send('clipboard:write', term.getSelection());
        term.clearSelection();
        return false;
      case 'paste':
        ev.preventDefault();
        void api.invoke('clipboard:read').then((clip) => {
          const p = pasteDecision(clip, platform);
          if (p.kind === 'text') term.paste(p.text);
          else api.send('pty:input', id, p.data);
        });
        return false;
      case 'send':
        ev.preventDefault();
        api.send('pty:input', id, d.data);
        return false;
    }
  });
  term.onData((data) => api.send('pty:input', id, data));
  term.onBinary((data) => api.send('pty:input', id, data));
  term.onResize(({ cols, rows }) => api.send('pty:resize', id, cols, rows));

  const entry = { term, fit, host };
  entries.set(id, entry);
  return entry;
}

export function fitTerminal(id: string): void {
  const e = entries.get(id);
  if (!e || e.host.offsetWidth === 0 || e.host.offsetHeight === 0) return;
  try {
    e.fit.fit();
  } catch {
    // not attached yet
  }
}

export function disposeTerminal(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.term.dispose();
  e.host.remove();
  entries.delete(id);
}
