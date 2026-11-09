import { createApp } from 'vue';
import App from './App.vue';
import './assets/main.css';
import { currentOS } from '@shared/platform';

// `html.is-win`: CSS for a window with the system buttons over the top right corner (titleBarOverlay) — Windows and
// Linux (#87): room for them, no traffic lights on the left. `html.is-linux` for Linux only.
if (currentOS !== 'mac') document.documentElement.classList.add('is-win');
if (currentOS === 'linux') document.documentElement.classList.add('is-linux');

// A file dropped outside a drop zone must not open in the window.
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });

createApp(App).mount('#app');
