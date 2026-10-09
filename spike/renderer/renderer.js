// Phase 0 spike renderer: one xterm.js per pane, raw passthrough to the PTY.
'use strict';
/* global Terminal, FitAddon, Unicode11Addon, WebLinksAddon, spike */

const panes = new Map(); // id -> { term, fit, el }
let isMac = false;

spike.envInfo().then((info) => {
  isMac = info.platform === 'darwin';
  document.getElementById('info').textContent =
    `${info.platform} / claude: ${info.claudePath || '見つかりません'}`;
});

spike.onData(({ id, data }) => panes.get(id)?.term.write(data));
spike.onExit(({ id, exitCode }) => {
  panes.get(id)?.term.write(`\r\n\x1b[2m[プロセス終了 code=${exitCode}]\x1b[0m\r\n`);
});

document.querySelectorAll('header button').forEach((btn) =>
  btn.addEventListener('click', () => openPane(btn.dataset.profile || null, btn.dataset.color, btn.textContent)),
);

/**
 * Key rule (spike version of the spec's §2.6-3):
 * everything goes to the CLI unchanged, except the few keys a terminal
 * emulator itself is expected to handle.
 */
function keyHandler(term, id) {
  return (ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    // Shift+Enter → newline in Claude Code input (same sequence /terminal-setup configures).
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      spike.input(id, '\x1b\r');
      return false;
    }
    // Copy only when there is a selection; otherwise Ctrl+C stays SIGINT for the CLI.
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
      ev.preventDefault();
      spike.clipWrite(term.getSelection());
      term.clearSelection();
      return false;
    }
    // Windows/Linux Ctrl+V: text → bracketed paste via xterm; image → raw ^V so claude reads the clipboard itself.
    if (!isMac && ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'v') {
      ev.preventDefault();
      spike.clipRead().then(({ text, hasImage }) => {
        if (hasImage || !text) spike.input(id, '\x16');
        else term.paste(text);
      });
      return false;
    }
    return true;
  };
}

async function openPane(profile, color, label) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.style.setProperty('--c', color);
  el.innerHTML = `<div class="bar"><span class="badge"></span><span class="path"></span><button title="閉じる">✕</button></div><div class="term"></div>`;
  el.querySelector('.badge').textContent = label.replace(/^\+\s*/, '');
  document.getElementById('panes').appendChild(el);

  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: 'Cascadia Mono, Consolas, Menlo, "MS Gothic", monospace',
    fontSize: 14,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: { background: '#1e1e1e' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => spike.openLink(uri)));
  term.open(el.querySelector('.term'));
  fit.fit();

  const cwd = document.getElementById('cwd').value.trim() || undefined;
  let res;
  try {
    res = await spike.spawn({ profile, cwd, cols: term.cols, rows: term.rows });
  } catch (err) {
    term.write(`\x1b[31m起動失敗: ${err.message}\x1b[0m\r\n`);
    return;
  }
  const { id, configDir } = res;
  el.querySelector('.path').textContent = `CLAUDE_CONFIG_DIR=${configDir}`;
  panes.set(id, { term, fit, el });

  term.attachCustomKeyEventHandler(keyHandler(term, id));
  term.onData((d) => spike.input(id, d));
  term.onBinary((d) => spike.input(id, d));
  term.onResize(({ cols, rows }) => spike.resize(id, cols, rows));
  new ResizeObserver(() => fit.fit()).observe(el.querySelector('.term'));
  term.focus();

  el.querySelector('.bar button').addEventListener('click', () => {
    spike.kill(id);
    term.dispose();
    panes.delete(id);
    el.remove();
    for (const p of panes.values()) p.fit.fit();
  });
}
