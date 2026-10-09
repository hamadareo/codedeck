import type { CodeDeckApi } from '../shared/ipc';

declare global {
  interface Window {
    codedeck: CodeDeckApi;
  }
}

export {};
