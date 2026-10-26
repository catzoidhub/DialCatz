import type { DialCatzBridge } from './index';

declare global {
  interface Window {
    dialcatz: DialCatzBridge;
  }
}

export {};
