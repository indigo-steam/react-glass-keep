// src/main.jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './i18n';
import './index.css';
import './i18n';
import App from './App.jsx';

// Register the PWA Service Worker (vite-plugin-pwa, autoUpdate)
registerSW({
  immediate: true, // install/update SW ASAP
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // Poll for updates periodically and whenever the app comes back to the foreground
    setInterval(() => { registration.update().catch(() => { }); }, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => { });
      }
    });
  },
});

// Reload once when a new service worker takes control (seamless app updates)
let swRefreshing = false;
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
