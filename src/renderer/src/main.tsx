import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import { App } from './App';
import { PopoutApp } from './PopoutApp';
import { api } from './api';

// Main tells each window its role (the main window, or one session's own window).
void api.invoke('window:context').then((ctx) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{ctx.kind === 'popout' ? <PopoutApp sessionId={ctx.sessionId} /> : <App />}</StrictMode>,
  );
});
