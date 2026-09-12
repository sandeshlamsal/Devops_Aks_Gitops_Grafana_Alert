import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser only ever talks to the UI service; nginx in the UI pod proxies /api
// to the user-management-app-api service (see nginx.conf). For `npm run dev`, proxy locally.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8080" },
  },
});
