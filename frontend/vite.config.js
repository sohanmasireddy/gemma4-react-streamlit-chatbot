import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/streamlitComponent.jsx',
      name: 'Gemma4ChatComponent',
      formats: ['es'],
      fileName: () => 'chatbot.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.css') ? 'chatbot.css' : 'assets/[name]-[hash][extname]',
      },
    },
    target: 'es2020',
  },
});
