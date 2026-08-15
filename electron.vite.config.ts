import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `electron` must stay external or the npm installer stub (which only
        // exports the executable path) gets bundled and contextBridge breaks.
        external: ['electron']
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
