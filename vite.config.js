import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // manifest.json is a static file in /public and linked by hand in
      // index.html, so the plugin's only job is to generate and
      // register the service worker that caches the app's own files.
      manifest: false,

      // The service worker updates itself in the background on a new
      // deploy and takes over on the next page load automatically —
      // no "click to update" prompt for staff to have to notice.
      registerType: 'autoUpdate',

      workbox: {
        // Precache the built app files plus the manifest/icons, so a
        // fully offline load (after at least one successful online
        // visit) has everything it needs, install icons included.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}']
      }
    })
  ],
})
