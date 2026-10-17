import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.SAAS_PROXY ?? 'http://localhost:8790';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // SSE (watch + /api/events) must stream: no websocket upgrade, no buffering/compression.
      '/api': {
        target,
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.setHeader('accept-encoding', 'identity'));
          proxy.on('proxyRes', (res) => {
            if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) res.headers['x-accel-buffering'] = 'no';
          });
        },
      },
      '/worker': { target, changeOrigin: true, ws: true },
    },
  },
});
