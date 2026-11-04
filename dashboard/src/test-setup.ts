// Runs before each dashboard test file (vite.config.mjs, setupFiles). Every page the dashboard loads on demand is
// loaded first, so a test's wait for a page measures only its rendering, not fetching and preparing its code, which
// took longer than a test's wait on a busy computer: the story page, Settings and routing tests on November 3, 2026,
// which loaded their own pages, and the told page's tests on November 4, which did not. The lists are the router's
// pages and the components loaded with React's lazy; test-setup.test.ts checks that every one in the source is here.
import { beforeAll } from 'vitest';
import { onDemandPages } from './router';

export const onDemandModules: Record<string, () => Promise<unknown>> = {
  './first-run': () => import('./first-run'),
  './new-project': () => import('./new-project'),
};

beforeAll(async () => {
  await Promise.all([
    ...onDemandPages.map(page => page.preload()),
    ...Object.values(onDemandModules).map(load => load()),
  ]);
});
