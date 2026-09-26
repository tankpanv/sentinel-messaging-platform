import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
const backendUrl = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:4000';
export default defineConfig({ plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } }, server: { host: '0.0.0.0', port: Number(process.env.FRONTEND_PORT || 5173), proxy: { '/api': backendUrl, '/ws': backendUrl.replace(/^http/, 'ws') } } });
