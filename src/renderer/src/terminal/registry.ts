import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { decideTerminalKey, pasteDecision, type AppAction, type Platform } from '@shared/keymap';
import { TERMINAL_THEMES, terminalFontFamily, type ResolvedTheme } from '@shared/theme';
import { api } from '../api';

/**
 * xterm.js instances live outside React so re-renders, pane moves and tab
 * switches never lose scrollback. One entry per session id, per window.
 *
 * A terminal created while its PTY is already running (another window, a
 * reload) first replays main's recent output, then continues with live data.
 * Every chunk carries its stream offset, so nothing is shown twice or lost.
 */
interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  /** Live chunks that arrived while the snapshot was loading. */
  pending: { data: string; end: number }[] | null;
  /** Stream offset already written to this terminal. */
  end: number;
}

const entries = new Map<string, Entry>();
let platform: Platform = 'other';
let appActionHandler: (action: AppAction) => void = () => {};
let appearance: { theme: ResolvedTheme; fontSize: number; fontFamily: string } = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: '',
};

export function setPlatform(p: Platform): void {
  platform = p;
}

export function setAppActionHandler(fn: (action: AppAction) => void): void {
  appActionHandler = fn;
}

/** Write the part of a chunk that lies beyond what the terminal already has. */
function writeFrom(e: Entry, data: string, end: number): void {
  if (end <= e.end) return;
  const fresh = end - e.end;
  e.term.write(fresh >= data.length ? data : data.slice(data.length - fresh));
  e.end = end;
}

// One global stream; each chunk goes to its session's terminal unmodified.
api.on('pty:data', (id, data, end) => {
  const e = entries.get(id);
  if (!e) return;
  if (e.pending) e.pending.push({ data, end });
  else writeFrom(e, data, end);
});

export function applyTerminalAppearance(next: typeof appearance): void {
  appearance = next;
  for (const [id, e] of entries) {
    e.term.options.theme = TERMINAL_THEMES[next.theme];
    e.host.style.backgroundColor = TERMINAL_THEMES[next.theme].background!;
    e.term.options.fontSize = next.fontSize;
    e.term.options.fontFamily = terminalFontFamily(next.fontFamily);
    fitTerminal(id);
  }
}

let gpu: boolean | undefined;

/**
 * True when WebGL runs on a real GPU. Without one (VMs, remote desktops, CI runners)
 * Chromium emulates WebGL in software (SwiftShader), which is slower than the DOM renderer.
 */
export function hardwareWebgl(): boolean {
  if (gpu !== undefined) return gpu;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return (gpu = false);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    gpu = !/swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer);
  } catch {
    gpu = false;
  }
  return gpu;
}

export function getTerminal(id: string): Entry {
  const existing = entries.get(id);
  if (existing) return existing;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.backgroundColor = TERMINAL_THEMES[appearance.theme].background!;
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: terminalFontFamily(appearance.fontFamily),
    fontSize: appearance.fontSize,
    scrollback: 10_000,
    macOptionIsMeta: true,
    // Windows ConPTY reflows itself; xterm must not reflow on top of it.
    windowsPty: navigator.userAgent.includes('Windows') ? { backend: 'conpty' } : undefined,
    theme: TERMINAL_THEMES[appearance.theme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => api.send('link:open', uri)));
  term.open(host);
  // GPU rendering keeps typing responsive with many busy sessions (§4). Falls back to the
  // DOM renderer when WebGL is unavailable, emulated in software, or the context is lost.
  if (hardwareWebgl()) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // no WebGL: keep the default renderer
    }
  }

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

  const entry: Entry = { term, fit, host, pending: [], end: 0 };
  entries.set(id, entry);
  void api.invoke('pty:snapshot', id).then(
    (snap) => {
      if (entries.get(id) !== entry) return;
      if (snap.data) term.write(snap.data);
      entry.end = snap.end;
      const queued = entry.pending ?? [];
      entry.pending = null;
      for (const c of queued) writeFrom(entry, c.data, c.end);
    },
    () => {
      const queued = entry.pending ?? [];
      entry.pending = null;
      for (const c of queued) writeFrom(entry, c.data, c.end);
    },
  );
  return entry;
}

/** The terminal's text (scrollback + screen), as the user sees it. */
export function terminalText(id: string): string {
  const e = entries.get(id);
  if (!e) return '';
  const b = e.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    const text = line?.translateToString(true) ?? '';
    // A soft-wrapped row continues the previous line.
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').replace(/\n+$/, '');
}

// Read access for automated UI tests: with GPU rendering the text is not in the DOM.
(window as unknown as { __codedeckTerminalText?: (id: string) => string }).__codedeckTerminalText =
  terminalText;

export function hasTerminal(id: string): boolean {
  return entries.has(id);
}

/** Paste text into a session as if the user pasted it (bracketed paste; nothing is submitted). */
export function pasteInto(id: string, text: string): boolean {
  const e = entries.get(id);
  if (!e) return false;
  e.term.paste(text);
  e.term.focus();
  return true;
}

export function focusTerminal(id: string): boolean {
  const e = entries.get(id);
  if (!e) return false;
  e.term.focus();
  return e.host.contains(document.activeElement);
}

/**
 * Ask claude to redraw for this terminal's size: a terminal that attached
 * mid-session replayed output drawn for another width.
 */
export function nudgeRedraw(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  const { cols, rows } = e.term;
  api.send('pty:resize', id, Math.max(cols - 1, 2), rows);
  setTimeout(() => api.send('pty:resize', id, e.term.cols, e.term.rows), 60);
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
