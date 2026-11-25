import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type ProxyOptions } from 'vite';
import { fontLicensePlugin, LICENSE_FILE } from './license-plugin';
import { compressPlugin, fontPreloadPlugin } from './perf-plugin';
import { pwaPlugin } from './pwa-plugin';

/**
 * The web console talks to the master under `/api/*` on its own origin, so the session cookie
 * (`__Host-ras`, SameSite=Strict) is first-party. In development Vite proxies `/api` to the master and
 * strips the prefix; in production the reverse proxy does the same (docs/design/p1-web-skeleton.md §3).
 */
const masterOrigin = process.env.REMYRAL_MASTER_ORIGIN ?? 'http://127.0.0.1:8080';

const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: masterOrigin,
    changeOrigin: false,
    rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
  },
};

export default defineConfig({
  // p8-pwa: `/sw.js` (service worker with the build's precache manifest), production builds only.
  // p14-web-perf: `.br` / `.gz` siblings of the hashed bundles for nginx, and the Diyalog body font preloaded (perf-plugin.ts).
  plugins: [react(), tailwindcss(), pwaPlugin(), compressPlugin(), fontPreloadPlugin(), fontLicensePlugin()],
  // p5-credentials-models: the console bundles `@remyral/protocol/credential-seal` (pure WebCrypto, no zod/node
  // imports) from its TypeScript source, so the browser seals credentials with exactly the code the worker
  // opens them with — no protocol build step is needed for the web image.
  resolve: { conditions: ['@remyral/source', ...defaultClientConditions] },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.REMYRAL_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.REMYRAL_WEB_PREVIEW_PORT ?? 4173),
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    // No inline <script>/<style> and no data: fonts/scripts: the bundle must run under the master's CSP
    // (`default-src 'self'`). Small images may still be inlined (img-src allows data:), we have none.
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2023',
    // The licence texts of every third-party package bundled into the console ship with it (Vite `build.license`,
    // plus the self-hosted fonts' OFL texts, license-plugin.ts): dist/third-party-licenses.md, served by the web image
    // at /third-party-licenses.md.
    license: { fileName: LICENSE_FILE },
    rolldownOptions: {
      output: {
        // p14-web-perf (docs/design/p14-web-perf.md §2): React, React DOM and the router change only with a dependency
        // bump, so they get a chunk of their own that stays cached (immutable, content-hashed) across app releases.
        // Every screen is its own lazy chunk (diyalog/preload.ts, the Diyalog matchers);
        // the rest of the split is rolldown's default (shared modules → shared chunks).
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react|react-dom|scheduler|react-router)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
