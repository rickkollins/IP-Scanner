import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` makes a normal static site in dist/.
// `npm run build:single` makes dist-single/index.html with everything
// (including the WASM geometry kernel) inlined, so it opens from disk.
export default defineConfig(({ mode }) => ({
  base: './',
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: () => true, chunkSizeWarningLimit: 4000 }
    : { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
}));
