import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        // Until @catzoid/mcatzp-host is on npm (MCatzP #3, #22): built from the MCatzP checkout next to this one.
        '@catzoid/mcatzp-host': resolve('../MCatzP/packages/host/src/index.ts'),
        '@catzoid/mcatzp-protocol': resolve('../MCatzP/packages/protocol/src/index.ts'),
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    // Dev only. macOS's file events replay recent changes each time a watcher is added, and Tailwind adds them on every
    // update, so styles were pushed again and again with no file changed. Polling only sees real changes.
    server: { watch: { useFsEvents: false, usePolling: true, interval: 1000 } as Record<string, unknown> },
    plugins: [vue(), tailwindcss()],
  },
});
