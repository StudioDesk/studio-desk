// Pages opened on demand (lazy-page.tsx): a page reads its one load of code with use() on every render, so code that
// arrives between React's suspended render and its retry still shows the page without React's error about use();
// loaded code shows at once; preload loads it once; a failed load shows its error and the next open loads again; and
// a missing code file reloads the dashboard once, both rendered directly and as a route the router opens. Each page's
// code is a stand-in module the test hands over itself.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Component, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isMissingModule, lazyPage, reloadOnceForMissingModule } from './lazy-page';

interface PageModule {
  Page: (props: { text: string }) => ReactNode;
}
const pageModule: PageModule = { Page: ({ text }) => <h1>{text}</h1> };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ErrorShown extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children;
  }
}

const shown = (page: ReactNode) => (
  <ErrorShown>
    <Suspense fallback={<p role="status">Loading the page…</p>}>{page}</Suspense>
  </ErrorShown>
);

// React retries a suspended page only when the render that suspended was awaited, as the browser always lets it.
const show = (page: ReactNode) =>
  act(async () => {
    render(shown(page));
  });

const conditionalUseErrors = () =>
  vi
    .mocked(console.error)
    .mock.calls.map(call => call.map(String).join(' '))
    .filter(text => text.includes('called use() to suspend'));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// React runs a test's renders inside act() by default; this test turns that off so React schedules its retry on its
// own, as in the browser, and the page's code arrives in the gap between the suspended render and that retry.
test('a page whose code arrives between the suspended render and React’s retry shows, with no error about use()', async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean },
    actEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  const code = deferred<PageModule>();
  const Page = lazyPage(() => {
    // Handed over right after the render that asked for it suspends, before React's retry.
    queueMicrotask(() => code.resolve(pageModule));
    return code.promise;
  }, 'Page');
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    root.render(shown(<Page text="The story" />));
    await vi.waitFor(() => expect(container.textContent).toBe('The story'));
    expect(conditionalUseErrors()).toEqual([]);
  } finally {
    root.unmount();
    container.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});

test('code that arrives after the page’s fallback shows the page, with no error about use()', async () => {
  const code = deferred<PageModule>();
  const Page = lazyPage(() => code.promise, 'Page');
  await show(<Page text="The story" />);
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => code.resolve(pageModule));
  expect(screen.getByRole('heading', { name: 'The story' })).toBeTruthy();
  expect(conditionalUseErrors()).toEqual([]);
});

test('once its code has loaded, the page shows at once on every later render, with no fallback', async () => {
  const importer = vi.fn(() => Promise.resolve(pageModule));
  const Page = lazyPage(importer, 'Page');
  await show(<Page text="Settings" />);
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  cleanup();
  render(shown(<Page text="Settings again" />));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Settings again' })).toBeTruthy();
  expect(importer).toHaveBeenCalledTimes(1);
});

test('preload loads the code once, and a later render uses it without importing again', async () => {
  const importer = vi.fn(() => Promise.resolve(pageModule));
  const Page = lazyPage(importer, 'Page');
  const first = Page.preload();
  expect(Page.preload()).toBe(first);
  await first;
  render(shown(<Page text="Runs" />));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Runs' })).toBeTruthy();
  expect(importer).toHaveBeenCalledTimes(1);
});

test('a failed load shows its error, and the next time the page opens it imports again', async () => {
  const importer = vi
    .fn<() => Promise<PageModule>>()
    .mockRejectedValueOnce(new Error('The page could not load'))
    .mockResolvedValue(pageModule);
  const Page = lazyPage(importer, 'Page');
  await show(<Page text="Artifacts" />);
  expect(screen.getByRole('alert').textContent).toBe('The page could not load');
  expect(importer).toHaveBeenCalledTimes(1);
  // The loader forgets the failed load once React has shown its error.
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  cleanup();
  await show(<Page text="Artifacts" />);
  expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeTruthy();
  expect(importer).toHaveBeenCalledTimes(2);
});

test('a page whose code file is missing reloads the dashboard once, and shows the error if it is still missing', async () => {
  const missing = new Error('Failed to fetch dynamically imported module: /assets/settings-page-1a2b.js');
  const reload = vi.fn();
  const First = lazyPage((): Promise<PageModule> => Promise.reject(missing), 'Page', reload);
  await show(<First text="Settings" />);
  expect(reload).toHaveBeenCalledTimes(1);
  // While the dashboard reloads the page keeps waiting rather than showing the error.
  expect(screen.getByRole('status')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sessionStorage.getItem(`tanstack_router_reload:${missing.message}`)).toBe('1');
  cleanup();
  // After the reload the tab starts with fresh pages; the file is still missing, so the error shows.
  const Again = lazyPage((): Promise<PageModule> => Promise.reject(missing), 'Page', reload);
  await show(<Again text="Settings" />);
  expect(screen.getByRole('alert').textContent).toBe(missing.message);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('only a missing code file reloads the dashboard', () => {
  const reload = vi.fn();
  expect(isMissingModule(new Error('error loading dynamically imported module: x'))).toBe(true);
  expect(isMissingModule(new Error('Importing a module script failed.'))).toBe(true);
  expect(isMissingModule('Failed to fetch dynamically imported module')).toBe(false);
  expect(reloadOnceForMissingModule(new Error('The page could not load'), reload)).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

test('a preload whose code fails to load still settles, and leaves the failure to the page', async () => {
  const failure = new Error('The page could not load');
  const Page = lazyPage((): Promise<PageModule> => Promise.reject(failure), 'Page');
  await Page.preload();
  await show(<Page text="Runs" />);
  expect(screen.getByRole('alert').textContent).toBe(failure.message);
});

// Pages opened through the router, on a memory history. The router preloads a route component's code before it shows
// the route and shows the route's error page when that preload fails, so a failed load must reach the page's render
// for the one-time reload to happen. Each test runs with the lazy page as the route's component and with the page
// inside the route's own component, as router.tsx opens its pages.
interface RoutePageModule {
  SettingsPage: () => ReactNode;
}
const routePageModule: RoutePageModule = { SettingsPage: () => <h1>Settings</h1> };
const routeShapes = [
  { shape: 'as the route’s component', inside: false },
  { shape: 'inside the route’s own component', inside: true },
];

function openRouter(importer: () => Promise<RoutePageModule>, reload: () => void, inside: boolean) {
  const Page = lazyPage(importer, 'SettingsPage', reload);
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => <h1>Home</h1> });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: inside ? () => <Page /> : Page,
    pendingComponent: () => <p role="status">Loading the page…</p>,
    errorComponent: ({ error }) => <p role="alert">{(error as Error).message}</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, settings]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

test.each(routeShapes)(
  'opened through the router $shape, a page whose code file is missing reloads once, and shows the error if still missing',
  async ({ inside }) => {
    const missing = new Error('Failed to fetch dynamically imported module: /assets/settings-page-1a2b.js');
    const reload = vi.fn();
    const importer = vi.fn((): Promise<RoutePageModule> => Promise.reject(missing));
    openRouter(importer, reload, inside);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(`tanstack_router_reload:${missing.message}`)).toBe('1');
    // While the dashboard reloads the route waits rather than showing its error page.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    // After the reload the tab starts with fresh pages. The file is still missing, so the route's error page shows
    // instead of a second reload.
    cleanup();
    openRouter(importer, reload, inside);
    expect((await screen.findByRole('alert')).textContent).toBe(missing.message);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledTimes(2);
  },
);

test.each(routeShapes)(
  'opened through the router $shape, a failed load shows the route’s error page, and the next open loads it again',
  async ({ inside }) => {
    const importer = vi
      .fn<() => Promise<RoutePageModule>>()
      .mockRejectedValueOnce(new Error('The page could not load'))
      .mockResolvedValue(routePageModule);
    const reload = vi.fn();
    const router = openRouter(importer, reload, inside);
    expect((await screen.findByRole('alert')).textContent).toBe('The page could not load');
    expect(importer).toHaveBeenCalledTimes(1);
    await act(async () => router.history.push('/'));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeTruthy();
    await act(async () => router.history.push('/settings'));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importer).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  },
);
