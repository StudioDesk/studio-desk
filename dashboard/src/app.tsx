import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { StreamFactory } from './live';
import { StreamFactoryContext } from './stream-context';
import type { createAppRouter } from './router';
import { ToastProvider } from './toast';

// The router decides what is on screen; the query cache holds the controller's records by name, and the
// project's event stream refreshes only the names it reports as changed.
export function App({
  router,
  queryClient,
  createStream = url => new EventSource(url),
}: {
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
  createStream?: StreamFactory;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <StreamFactoryContext.Provider value={createStream}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </StreamFactoryContext.Provider>
    </QueryClientProvider>
  );
}
