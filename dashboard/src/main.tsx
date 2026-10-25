import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The design system's fonts, tokens and components (v1.0 item 23).
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './design/tokens.css';
import './design/bundle.css';
import { App } from './app';
import { createAppRouter } from './router';

// Records change only when the controller says so, so nothing is refetched on a timer or on window focus.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

const root = document.getElementById('root');
if (!root) throw new Error('The page has no root element.');
createRoot(root).render(
  <StrictMode>
    <App router={createAppRouter()} queryClient={queryClient} />
  </StrictMode>,
);
