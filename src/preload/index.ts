import { contextBridge, ipcRenderer } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type CodeDeckApi,
  type EventChannel,
  type InvokeChannel,
  type SendChannel,
} from '@shared/ipc';

const invokeOk = new Set<string>(INVOKE_CHANNELS);
const sendOk = new Set<string>(SEND_CHANNELS);
const eventOk = new Set<string>(EVENT_CHANNELS);

// Only the channels in the contract are reachable from the renderer.
const api: CodeDeckApi = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeOk.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: SendChannel, ...args: unknown[]) {
    if (sendOk.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(channel: EventChannel, listener: (...args: never[]) => void) {
    if (!eventOk.has(channel)) return () => {};
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]) =>
      (listener as (...a: unknown[]) => void)(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
} as CodeDeckApi;

contextBridge.exposeInMainWorld('codedeck', api);
