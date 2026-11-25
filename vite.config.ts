import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content-Security-Policy for production builds only (Vite's dev server needs inline scripts + websockets).
 * connect-src 'self' is the technical guarantee that the app cannot send file contents anywhere.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'nbt-editor-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    cspPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['icon.png', 'icon.gif', 'favicon.png'],
      manifest: {
        name: 'NBT-Editor',
        short_name: 'NBT-Editor',
        description: 'Explore and edit Minecraft NBT files in your browser. Files never leave your device.',
        theme_color: '#16130F',
        background_color: '#16130F',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'application/octet-stream': ['.dat', '.nbt', '.mca', '.mcr', '.schem', '.schematic', '.litematic', '.mcstructure', '.dat_old', '.mcc'],
            },
          },
        ],
      } as never,
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,gif,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
} as never);
