// Pages opened on demand load their code the first time they are shown, so Home's first load stays small. Each page
// keeps one load of its code and reads it with React's use() on every render, whether the code has arrived or not:
// a page that read it only while waiting broke React's rule for use() when the code arrived between React's
// suspended render and its retry, which a busy computer made more likely.
import { createElement, use, type ComponentType, type ReactElement } from 'react';

// A load as React reads it: its status and value or reason, which React also sets on promises it is given.
type Load<T> = Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown };

// preload() settles once the page's code has loaded or failed to load, and never fails: a failure stays in the page's
// load for its render to handle, as the router library's pages did, because the router shows its error page for a
// failed preload without rendering the page.
export type LazyPage<P> = ((props: P) => ReactElement) & { preload: () => Promise<void> };
type PropsOf<C> = C extends ComponentType<infer P> ? P : never;

// The messages browsers give when a page's code file is gone, as after the dashboard was rebuilt; the router library
// recognized the same ones.
export function isMissingModule(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    (message.startsWith('Failed to fetch dynamically imported module') ||
      message.startsWith('error loading dynamically imported module') ||
      message.startsWith('Importing a module script failed'))
  );
}

// A page whose code is missing reloads the dashboard once, to pick up the rebuilt files; the reload is recorded for
// the browser tab (under the router library's key, so a reload it already made counts), so a file that is still
// missing shows its error instead of reloading again. Answers whether it reloads.
export function reloadOnceForMissingModule(error: unknown, reload: () => void = () => window.location.reload()) {
  if (!isMissingModule(error)) return false;
  try {
    const key = `tanstack_router_reload:${(error as Error).message}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {
    // Without browser storage a reload could not happen only once, so the error shows instead.
    return false;
  }
  reload();
  return true;
}

// What a page waits on while the dashboard reloads.
const reloading: Promise<never> = new Promise(() => {});

// A page component from a module's named export. `reload` is how the page reloads the dashboard (tests replace it).
export function lazyPage<M, K extends keyof M & string>(
  importer: () => Promise<M>,
  exportName: K,
  reload?: () => void,
): LazyPage<PropsOf<M[K]>> {
  type P = PropsOf<M[K]>;
  let load: Load<M> | undefined, ready: Promise<void> | undefined;
  let forgetting: Load<M> | undefined, reloadingFor: Load<M> | undefined;
  // One load per page, started by its first render or preload. Its status is set as soon as the code arrives, so a
  // later render returns at once without waiting.
  const start = (): Load<M> => {
    const started: Load<M> = new Promise<M>(resolve => resolve(importer()));
    started.status = 'pending';
    started.then(
      value => {
        started.status = 'fulfilled';
        started.value = value;
      },
      (reason: unknown) => {
        started.status = 'rejected';
        started.reason = reason;
      },
    );
    // What preload() hands the router: the same load, settled either way, after its status is set.
    ready = started.then(
      () => undefined,
      () => undefined,
    );
    return (load = started);
  };
  // The router preloads a page's code each time the page opens, so a preload after a failed load loads it again.
  const preload = (): Promise<void> => {
    if (!load || load.status === 'rejected') start();
    return ready as Promise<void>;
  };
  // A failed load is forgotten once React has shown its error, so the next time the page opens it loads again. It is
  // kept until then because React renders a failed page once more before it shows the error.
  const forget = (failed: Load<M>) => {
    if (forgetting === failed) return;
    forgetting = failed;
    setTimeout(() => {
      if (load === failed) load = undefined;
    }, 0);
  };
  function Page(props: P) {
    const current = load ?? start();
    if (current.status === 'rejected') {
      // While the dashboard reloads, the page keeps waiting rather than showing the error, as the router library's
      // pages did, on every render of that load. Throwing a promise that never settles waits without handing React a
      // different load to use().
      if (reloadingFor === current || reloadOnceForMissingModule(current.reason, reload)) {
        reloadingFor = current;
        throw reloading;
      }
      forget(current);
    }
    // Read on every render: use() waits for the code, returns it once it has arrived, or throws a failed load's
    // error to the route's error handling.
    const code = use(current as Promise<M>);
    return createElement(code[exportName] as ComponentType<Record<string, unknown>>, props as Record<string, unknown>);
  }
  return Object.assign(Page, { preload });
}
