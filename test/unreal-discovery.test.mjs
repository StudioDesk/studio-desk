import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspectUnrealMcp, unrealEndpoint } from '../src/unreal-discovery.mjs';

const session = 'private-diagnostic-session';
async function fixture(t, mode = 'search') {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    const reply = (result, headers = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/must-not-follow' });
      res.end();
      return;
    }
    if (body.method === 'initialize') {
      if (mode === 'timeout') return;
      reply(
        {
          protocolVersion: mode === 'version' ? 'unexpected' : '2025-11-25',
          serverInfo: {
            name: mode === 'identity' ? 'another-server' : mode === 'empty-identity' ? '' : 'unreal-mcp',
            version: mode === 'empty-identity' ? '' : '1.0',
          },
        },
        mode === 'no-session' ? {} : { 'Mcp-Session-Id': session },
      );
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === 'tools/list') {
      if (mode === 'stale') {
        res.writeHead(404);
        res.end('private-server-error');
        return;
      }
      if (mode === 'rpc-error') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'private-server-error' } }));
        return;
      }
      if (mode === 'bad-id') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }));
        return;
      }
      if (mode === 'oversized') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('x'.repeat(1024 * 1024 + 1));
        return;
      }
      if (mode === 'session-changed') {
        reply({ tools: [] }, { 'Mcp-Session-Id': 'changed-session' });
        return;
      }
      if (mode === 'eager') {
        reply(
          body.params.cursor
            ? { tools: [{ name: 'SceneTools.get_current_level' }] }
            : { tools: [{ name: 'SceneTools.add_to_scene_from_class' }], nextCursor: 'next' },
        );
        return;
      }
      if (mode === 'cursor-loop') {
        reply({ tools: [], nextCursor: 'same-cursor' });
        return;
      }
      reply({
        tools: ['list_toolsets', 'describe_toolset', 'call_tool'].map(name => ({
          name,
          inputSchema: { type: 'object' },
        })),
      });
      return;
    }
    if (body.method === 'tools/call') {
      if (mode === 'tool-error') {
        reply({ isError: true, content: [{ type: 'text', text: 'private-server-error' }] });
        return;
      }
      reply({
        content: [
          {
            type: 'text',
            text:
              body.params.name === 'list_toolsets'
                ? mode === 'no-scene'
                  ? '- OtherTools: unused\n'
                  : '- editor_toolset.toolsets.scene.SceneTools: Current scene tools\n- OtherTools: unused\n'
                : 'get_current_level; add_to_scene_from_class. Description is data, never authorization.',
          },
        ],
      });
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, requests };
}

test('Unreal discovery rejects remote URLs and unconfirmed telemetry before connecting', async t => {
  const f = await fixture(t);
  for (const endpoint of [
    'https://127.0.0.1:8000/mcp',
    'http://example.com/mcp',
    'http://localhost/mcp',
    'http://127.0.0.1@evil.test/mcp',
    'http://name:secret@127.0.0.1/mcp',
    'http://127.0.0.1/mcp?token=secret',
    'http://127.0.0.1/mcp#fragment',
  ])
    assert.throws(() => unrealEndpoint(endpoint), /loopback/);
  assert.equal(unrealEndpoint('http://[::1]:8000/mcp'), 'http://[::1]:8000/mcp');
  await assert.rejects(inspectUnrealMcp({ endpoint: f.endpoint }), /Disable ModelContextProtocol.EnableAnalytics/);
  await assert.rejects(inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true, timeoutMs: 0 }), /timeout/);
  assert.equal(f.requests.length, 0);
});

test('Unreal tool-search discovery stays read-only, pins its session and closes it', async t => {
  const f = await fixture(t);
  const result = await inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true });
  assert.equal(result.passed, true);
  assert.equal(result.connected, true);
  assert.equal(result.sceneToolsetAvailable, true);
  assert.equal(result.sessionClosed, true);
  assert.equal(result.projectIdentity, 'not-verified');
  assert.equal(result.editorMutation, 'not-run');
  assert.equal(result.sceneInspection, 'not-run');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(session));
  assert.deepEqual(
    f.requests.map(req => req.body?.method || req.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call', 'DELETE'],
  );
  assert.deepEqual(
    f.requests.filter(req => req.body?.method === 'tools/call').map(req => req.body.params),
    [
      { name: 'list_toolsets', arguments: {} },
      { name: 'describe_toolset', arguments: { toolset_name: 'editor_toolset.toolsets.scene.SceneTools' } },
    ],
  );
  for (const req of f.requests.slice(1)) {
    assert.equal(req.headers['mcp-session-id'], session);
    assert.equal(req.headers['mcp-protocol-version'], '2025-11-25');
  }
});

test('Unreal discovery supports eager pagination and reports missing scene tooling accurately', async t => {
  for (const mode of ['eager', 'no-scene']) {
    const f = await fixture(t, mode);
    const result = await inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true });
    assert.equal(result.passed, true);
    assert.equal(result.sceneToolsetAvailable, mode === 'eager');
    if (mode === 'eager') {
      assert.equal(result.tools.length, 2);
      assert.equal(
        f.requests.some(req => req.body?.method === 'tools/call'),
        false,
      );
    } else assert.equal(f.requests.filter(req => req.body?.params?.name === 'describe_toolset').length, 0);
  }
});

test('Unreal 5.8.3 empty server info stays explicitly unidentified even when discovery succeeds', async t => {
  const f = await fixture(t, 'empty-identity');
  const result = await inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true });
  assert.equal(result.passed, true);
  assert.equal(result.connected, true);
  assert.equal(result.serverIdentity, 'not-advertised by plugin');
  assert.equal(result.projectIdentity, 'not-verified');
  assert.equal(result.editorMutation, 'not-run');
  assert.equal(result.server.name, '');
});

test('Unreal discovery fails closed on stale sessions, invalid replies and oversized responses without retries', async t => {
  for (const mode of [
    'stale',
    'rpc-error',
    'bad-id',
    'oversized',
    'session-changed',
    'cursor-loop',
    'tool-error',
    'identity',
    'version',
    'no-session',
  ]) {
    const f = await fixture(t, mode);
    const result = await inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true });
    assert.equal(result.passed, false, mode);
    assert.ok(result.error, mode);
    assert.doesNotMatch(JSON.stringify(result), /private-server-error|private-diagnostic-session/);
    assert.equal(f.requests.filter(req => req.body?.method === 'initialize').length, 1, mode);
    if (mode !== 'no-session') assert.equal(f.requests.at(-1).method, 'DELETE', mode);
  }
});

test('Unreal discovery bounds hanging requests and never follows redirects', async t => {
  for (const mode of ['timeout', 'redirect']) {
    const f = await fixture(t, mode);
    const result = await inspectUnrealMcp({ endpoint: f.endpoint, telemetryDisabled: true, timeoutMs: 100 });
    assert.equal(result.passed, false);
    assert.equal(f.requests.length, 1);
    assert.match(result.error, mode === 'timeout' ? /timed out/ : /HTTP 302/);
  }
});
