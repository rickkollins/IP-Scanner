import './styles.css';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initKernel } from './core/kernel.js';
import { App } from './app/app.js';
import { icon } from './app/icons.js';

async function main() {
  document.querySelector('.logo').innerHTML = icon('logo', 22);
  document.querySelector('#help').innerHTML = icon('help', 18);
  document.querySelector('#theme').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 18);
  try {
    // The single-file build inlines the kernel as a data: URL; hand the bytes
    // over directly so no fetch is needed (some hosts block fetching data: URLs).
    if (wasmUrl.startsWith('data:')) {
      const bin = atob(wasmUrl.slice(wasmUrl.indexOf(',') + 1));
      const wasmBinary = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) wasmBinary[i] = bin.charCodeAt(i);
      await initKernel({ wasmBinary });
    } else {
      await initKernel({ locateFile: () => wasmUrl });
    }
  } catch (e) {
    document.querySelector('#loading').textContent = `Could not start the geometry kernel: ${e.message}`;
    return;
  }
  const app = new App(document.querySelector('#app'));
  window.forge = app; // handy for debugging from the console
  // Follow theme changes made by a hosting page as well as our own toggle.
  new MutationObserver(() => {
    app.viewport.applyTheme();
    document.querySelector('#theme').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 18);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.querySelector('#loading').remove();

  const welcome = document.querySelector('#welcome');
  const updateWelcome = () => { welcome.hidden = app.doc.features.length > 0 || !!app.editing; };
  const regen = app.regenerate.bind(app);
  app.regenerate = () => { regen(); updateWelcome(); };
  welcome.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    const w = b.dataset.w;
    if (w === 'sketch') app.startFeature('sketch');
    if (w === 'box') app.startFeature('box');
    if (w === 'import') app.importDialog();
    if (w === 'example') app.loadExample();
  });

  if (!(await app.restoreAutosave())) updateWelcome();
  else app.toast('Restored your last session');
}

main();
