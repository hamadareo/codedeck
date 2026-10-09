// Phase 0 spike: Electron main process. Owns the PTYs; the renderer only draws.
'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { profileDir, claudeSpawnSpec, resolveClaude } = require('./platform');

/** @type {Map<number, import('node-pty').IPty>} */
const ptys = new Map();
let nextId = 1;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: '#1e1e1e',
    title: 'CodeDeck spike',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.SPIKE_SMOKE) runSmoke();
}

// SPIKE_SMOKE=1: open one default-profile pane, print what xterm.js rendered, quit.
function runSmoke() {
  win.webContents.once('did-finish-load', async () => {
    await win.webContents.executeJavaScript(`document.querySelector('button[data-profile=""]').click()`);
    await new Promise((r) => setTimeout(r, 9000));
    const text = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.xterm-rows > div')].map(d => d.textContent).join('\\n')`,
    );
    console.log('SMOKE-RENDERED-BEGIN\n' + text + '\nSMOKE-RENDERED-END');
    app.quit();
  });
}

ipcMain.handle('env:info', () => ({
  platform: process.platform,
  claudePath: resolveClaude(),
  home: os.homedir(),
}));

ipcMain.handle('pty:spawn', (_e, { profile, cwd, cols, rows }) => {
  // profile === null → the user's normal ~/.claude (no CLAUDE_CONFIG_DIR)
  const configDir = profile ? profileDir(profile) : null;
  if (configDir) fs.mkdirSync(configDir, { recursive: true });
  const spec = claudeSpawnSpec({ configDir });
  const p = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || os.homedir(),
    env: spec.env,
    useConpty: true,
  });
  const id = nextId++;
  ptys.set(id, p);
  // Observe only: output is forwarded unmodified.
  p.onData((data) => win?.webContents.send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    win?.webContents.send('pty:exit', { id, exitCode });
  });
  return { id, configDir: configDir || path.join(os.homedir(), '.claude') };
});

ipcMain.on('pty:input', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  try {
    ptys.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1));
  } catch {
    /* resize after exit */
  }
});
ipcMain.on('pty:kill', (_e, { id }) => ptys.get(id)?.kill());

ipcMain.handle('clip:read', () => ({
  text: clipboard.readText(),
  hasImage: !clipboard.readImage().isEmpty(),
}));
ipcMain.on('clip:write', (_e, text) => clipboard.writeText(text));
ipcMain.on('link:open', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const p of ptys.values()) p.kill();
  app.quit();
});
