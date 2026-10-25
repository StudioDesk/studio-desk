// Development tool: a read-only preview of this copy's built dashboard on the live controller's records, for
// checking a page against the design before it is integrated. It serves dist/ and passes only GET and HEAD
// requests on to the controller, so pages show real records and nothing can change them: every other method is
// refused here, and the page gets no valid request token, so the controller would refuse a write anyway.
// The page carries the controller's own Content-Security-Policy (src/server.mjs), so what the real dashboard would
// block is blocked here too.
// Usage: npm run build, then node scripts/preview-dashboard.mjs [port, default 4318] [controller, default http://127.0.0.1:4317]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [port = '4318', controller = 'http://127.0.0.1:4317'] = process.argv.slice(2);
const dist = fileURLToPath(new URL('../dist/', import.meta.url)),
  upstream = new URL(controller);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const policy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://preview');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'This is a read-only preview of the dashboard. Nothing can be changed here.' }));
      return;
    }
    const file = path.join(dist, decodeURIComponent(url.pathname));
    if (url.pathname !== '/' && file.startsWith(dist) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // Records, the event stream and the controller's own scripts come from the controller.
    if (url.pathname.startsWith('/api/') || /\.(?:js|css|svg|png|ico)$/.test(url.pathname)) {
      const headers = { ...req.headers, host: upstream.host };
      delete headers.origin;
      delete headers.referer;
      const forward = http.request(
        { hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
        answer => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      // A reader that leaves mid-answer (a closed tab ends its event stream) destroys the forward; its error then
      // comes after the answer began, so only an unanswered request gets the 502.
      forward.on('error', error => (res.headersSent ? res.destroy() : res.writeHead(502).end(String(error))));
      req.on('close', () => forward.destroy());
      forward.end();
      return;
    }
    // Any other address is a page of the dashboard.
    const shell = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('%STUDIO_TOKEN%', 'read-only-preview');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy }).end(shell);
  })
  .listen(Number(port), '127.0.0.1', () =>
    console.log(`Read-only preview on http://127.0.0.1:${port}, with records from ${controller}.`),
  );
