import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (mode === 'production' && env.VITE_AUTH_MOCK === 'true') {
    throw new Error('VITE_AUTH_MOCK is development-only and cannot be enabled in production builds.')
  }
  return {
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
  },
  }
})
