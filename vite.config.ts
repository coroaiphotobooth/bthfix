import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vercel-safe config: DO NOT inject server secrets into client bundle.
// If you need client-side env vars, use VITE_* variables only.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    port: 3000,
  },
});
