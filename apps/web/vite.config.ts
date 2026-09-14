import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const target = process.env.PROBYU_API_ORIGIN ?? 'http://127.0.0.1:3100';
const proxyKey = process.env.FAMILY_PROXY_KEY;
if (proxyKey !== undefined) {
  const upstream = new URL(target);
  if (
    !/^[a-f0-9]{64}$/.test(proxyKey) ||
    upstream.origin !== target ||
    !['http:', 'https:'].includes(upstream.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
  ) {
    throw new Error('Family proxy requires an explicit loopback upstream and private key.');
  }
}

const securityHeaders = (dev: boolean) => ({
  'Content-Security-Policy': `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${dev ? ' ws://127.0.0.1:* ws://localhost:*' : ''}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // This is the public static shell only; private /v1 responses retain API no-store.
  'Cache-Control': 'no-cache',
});
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: securityHeaders(true),
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            // Never forward browser-supplied identity assertions or forwarding chains.
            for (const header of [
              'x-forwarded-for',
              'forwarded',
              'x-real-ip',
              'x-probyu-client-ip',
              'x-probyu-proxy-key',
            ])
              outgoing.removeHeader(header);
            if (proxyKey !== undefined) {
              outgoing.setHeader('x-probyu-client-ip', incoming.socket.remoteAddress ?? '');
              outgoing.setHeader('x-probyu-proxy-key', proxyKey);
            }
          });
        },
      },
    },
  },
  preview: { headers: securityHeaders(false) },
});
