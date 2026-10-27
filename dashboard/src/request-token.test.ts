// A command refused for a request token that is not this start's, as after a controller restart, reads the new
// token from the page the controller serves and is sent once more (api.ts send() and refreshToken()). Nothing
// else is sent again, and a command still refused, or without a token to read, asks for a reload.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { refreshToken, send } from './api';

interface Sent {
  url: string;
  method: string;
  token?: string;
  cache?: RequestCache;
  body?: string;
}
let requests: Sent[], meta: HTMLMetaElement;

beforeEach(() => {
  requests = [];
  meta = Object.assign(document.createElement('meta'), { name: 'studio-token', content: 'old' });
  document.head.append(meta);
});
afterEach(() => {
  document.head.querySelectorAll('meta[name="studio-token"]').forEach(element => element.remove());
  vi.unstubAllGlobals();
});

const stale = { error: 'Invalid controller request.' },
  restarted = 'The controller restarted. Reload this page to continue.',
  page = (token: string) =>
    `<!doctype html><html><head><meta charset="utf-8" /><meta name="studio-token" content="${token}" /><title>Studio desk</title></head><body><div id="root"></div></body></html>`,
  reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : structuredClone(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

// Installs fetch, recording each request with the token it carries; `answer` replies to it, or throws as an
// unreachable controller does.
function answer(respond: (request: Sent) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const request: Sent = {
        url,
        method: options.method ?? 'GET',
        token: (options.headers as Record<string, string> | undefined)?.['X-Studio-Token'],
        cache: options.cache,
        body: options.body as string | undefined,
      };
      requests.push(request);
      return respond(request);
    }),
  );
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message,
  );

test.each(['POST', 'PATCH'] as const)(
  'a %s refused for a stale token reads the new token from the page and is sent once more with it',
  async method => {
    let commands = 0;
    answer(request =>
      request.method === 'GET'
        ? reply(200, page('new'))
        : ++commands === 1
          ? reply(403, stale)
          : reply(200, { ok: true }),
    );
    const body = JSON.stringify({ projectId: 'project-x', title: 'Renamed' });
    expect(await send('/api/tasks/T-1', { projectId: 'project-x', title: 'Renamed' }, method)).toEqual({ ok: true });
    expect(requests).toEqual([
      { url: '/api/tasks/T-1', method, token: 'old', body },
      { url: '/', method: 'GET', cache: 'no-store' },
      { url: '/api/tasks/T-1', method, token: 'new', body },
    ]);
    expect(meta.content).toBe('new');
  },
);

test('a command refused again with the new token asks for a reload, and is not sent a third time', async () => {
  answer(request => (request.method === 'GET' ? reply(200, page('new')) : reply(403, stale)));
  expect(await refusal(send('/api/intake', { projectId: 'project-x', idea: 'Add a page.' }))).toBe(restarted);
  expect(requests.map(request => [request.method, request.token])).toEqual([
    ['POST', 'old'],
    ['GET', undefined],
    ['POST', 'new'],
  ]);
});

const unreadable: [string, () => unknown][] = [
  ['the controller cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['its page carries no token', () => reply(200, '<!doctype html><title>Studio desk</title>')],
  ['its page is refused', () => reply(404, { error: 'Page not found.' })],
];
test.each(unreadable)(
  'a command refused for its token asks for a reload when %s, keeping the token',
  async (_, served) => {
    answer(request => (request.method === 'GET' ? served() : reply(403, stale)));
    expect(await refusal(send('/api/tasks/T-1', { projectId: 'project-x' }, 'PATCH'))).toBe(restarted);
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual(['PATCH /api/tasks/T-1', 'GET /']);
    expect(meta.content).toBe('old');
  },
);

test.each([
  [403, 'Cross-origin requests are not accepted.'],
  [403, 'Use the loopback URL printed by the controller.'],
  [400, 'A task needs a title.'],
  [503, 'Controller is stopping.'],
])('a %i refusal "%s" is not sent again and keeps its own message', async (status, error) => {
  answer(() => reply(status, { error }));
  expect(await refusal(send('/api/tasks', { projectId: 'project-x' }))).toBe(error);
  expect(requests).toHaveLength(1);
  expect(meta.content).toBe('old');
});

test('a refusal without a message, and a controller that cannot be reached, fail as before', async () => {
  answer(() => reply(403, {}));
  expect(await refusal(send('/api/tasks', {}))).toBe('The controller refused the request (403).');
  answer(() => Promise.reject(new TypeError('Failed to fetch')));
  expect(await refusal(send('/api/tasks', {}))).toBe('Failed to fetch');
  expect(requests.map(request => request.url)).toEqual(['/api/tasks', '/api/tasks']);
});

test('commands refused together share one read of the page, and each is sent again with the new token', async () => {
  let serve!: () => void;
  const held = new Promise<void>(resolve => (serve = resolve));
  answer(async request => {
    if (request.method === 'GET') {
      await held;
      return reply(200, page('new'));
    }
    return request.token === 'old' ? reply(403, stale) : reply(200, { sent: request.url });
  });
  const first = send('/api/a', { n: 1 }),
    second = send('/api/b', { n: 2 }, 'PATCH');
  // Both refusals have asked for the token before the page answers.
  await new Promise(resolve => setTimeout(resolve, 0));
  serve();
  expect(await Promise.all([first, second])).toEqual([{ sent: '/api/a' }, { sent: '/api/b' }]);
  expect(requests.map(request => `${request.method} ${request.url} ${request.token ?? ''}`.trim())).toEqual([
    'POST /api/a old',
    'PATCH /api/b old',
    'GET /',
    'POST /api/a new',
    'PATCH /api/b new',
  ]);
});

test('the refresh reads the token from the page that says the dashboard is not built, and each later one reads the page again', async () => {
  answer(() => reply(503, page('unbuilt')));
  expect(await refreshToken()).toBe(true);
  expect(meta.content).toBe('unbuilt');
  answer(() => reply(500, page('other')));
  expect(await refreshToken()).toBe(false);
  expect(meta.content).toBe('unbuilt');
  // A page that lost its meta gets one, where send() reads it.
  meta.remove();
  answer(() => reply(200, page('new')));
  expect(await refreshToken()).toBe(true);
  expect(document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content).toBe('new');
  expect(requests.map(request => request.url)).toEqual(['/', '/', '/']);
});
