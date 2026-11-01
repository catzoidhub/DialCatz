import { createApp } from 'vue';
import App from './App.vue';
import './assets/main.css';
import { currentOS } from '@shared/platform';

// `html.is-win`: CSS for Windows only (room for the window buttons at the top right, no traffic lights on the left).
if (currentOS === 'windows') document.documentElement.classList.add('is-win');

// A file dropped outside a drop zone must not open in the window.
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });

createApp(App).mount('#app');
