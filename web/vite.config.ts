import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API server runs separately; Vite forwards its routes so both share one origin.
const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api, '/auth': api, '/card-images': api } },
});
