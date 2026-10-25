// Connection diagnostics only. This module never dispatches editor operations.
// Production integration still needs controller leases, a journal and reconciliation.
const protocolVersion = '2025-11-25';
const maxBytes = 1024 * 1024;
const sceneToolsets = ['editor_toolset.toolsets.scene.SceneTools', 'SceneTools'];

export function unrealEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Unreal MCP endpoint must be an absolute loopback HTTP URL.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-zA-Z0-9/_-]+$/.test(url.pathname)
  ) {
    throw new Error(
      'Unreal MCP endpoint must use a literal loopback HTTP address, without credentials, query or fragment.',
    );
  }
  return url.href;
}

async function boundedBody(response) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Unreal MCP response exceeds the 1 MB limit.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Unreal MCP response exceeds the 1 MB limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Raw tool descriptions are untrusted data. They are retained for inspection,
// never evaluated, turned into instructions, or used to authorize new calls.
function toolText(result) {
  if (!result || typeof result !== 'object' || (result.isError !== undefined && result.isError !== false))
    throw new Error('Unreal MCP discovery tool returned an error.');
  if (
    !Array.isArray(result.content) ||
    result.content.some(block => block.type !== 'text' || typeof block.text !== 'string')
  )
    throw new Error('Unreal MCP discovery returned an unsupported content format.');
  return result.content.map(block => block.text).join('\n');
}

export async function inspectUnrealMcp({
  endpoint = 'http://127.0.0.1:8000/mcp',
  telemetryDisabled = false,
  timeoutMs = 5000,
} = {}) {
  endpoint = unrealEndpoint(endpoint);
  if (telemetryDisabled !== true)
    throw new Error(
      'Disable ModelContextProtocol.EnableAnalytics in Unreal before connecting, then explicitly confirm telemetryDisabled.',
    );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000)
    throw new Error('Unreal MCP request timeout must be 50–10000 ms.');
  let session,
    nextId = 1;
  const report = {
    version: 'studio-unreal-discovery-v1',
    endpoint,
    passed: false,
    connected: false,
    telemetry: 'operator-confirmed disabled; not independently verified',
    editorMutation: 'not-run',
    projectIdentity: 'not-verified',
    sceneInspection: 'not-run',
    build: 'not-run',
    playtest: 'not-run',
    sessionClosed: false,
  };
  const request = async (method, params, notification = false) => {
    // Deliberate hard allowlist: no call_tool, code execution, or editor methods.
    if (
      !['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(method) ||
      (method === 'tools/call' && !['list_toolsets', 'describe_toolset'].includes(params?.name))
    )
      throw new Error('Only read-only Unreal MCP discovery is permitted.');
    const id = notification ? undefined : nextId++;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) {
      headers['Mcp-Session-Id'] = session;
      headers['MCP-Protocol-Version'] = protocolVersion;
    }
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Unreal MCP ${method} failed with HTTP ${response.status}; no retry was performed.`);
      }
      const returnedSession = response.headers.get('Mcp-Session-Id');
      if (method === 'initialize') {
        if (!returnedSession || !/^[a-zA-Z0-9_-]{1,128}$/.test(returnedSession))
          throw new Error('Unreal MCP did not return a valid session header.');
        session = returnedSession;
      } else if (returnedSession && returnedSession !== session)
        throw new Error('Unreal MCP session changed during discovery; reconnect explicitly.');
      const text = await boundedBody(response);
      if (notification) {
        if ((response.status !== 202 && response.status !== 204) || text.trim())
          throw new Error('Unreal MCP did not acknowledge initialization.');
        return;
      }
      if (!response.headers.get('content-type')?.startsWith('application/json'))
        throw new Error('Unreal MCP returned an unsupported transport format.');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('Unreal MCP returned malformed JSON.');
      }
      if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result'))
        throw new Error('Unreal MCP returned an invalid or failed JSON-RPC response.');
      return body.result;
    } finally {
      // Cancel unread bodies on validation failures; do not leave a stream open.
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  };
  try {
    const initialized = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'studio-read-only-preflight', version: '0.1.0' },
    });
    // The installed 5.8.3 plugin leaves ServerInfo's strings empty in its
    // initializer. Record that limitation; discovery never establishes project
    // identity or permission to mutate an editor. A different advertised server
    // name still fails closed.
    if (
      initialized?.protocolVersion !== protocolVersion ||
      !['unreal-mcp', ''].includes(initialized?.serverInfo?.name) ||
      typeof initialized.serverInfo.version !== 'string' ||
      initialized.serverInfo.version.length > 128
    )
      throw new Error('Endpoint is not the expected Unreal MCP server/protocol.');
    report.server = {
      name: initialized.serverInfo.name,
      version: initialized.serverInfo.version,
      protocolVersion: initialized.protocolVersion,
    };
    report.serverIdentity = initialized.serverInfo.name
      ? 'advertised only; not authenticated'
      : 'not-advertised by plugin';
    await request('notifications/initialized', {}, true);
    report.connected = true;
    const tools = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const listed = await request('tools/list', cursor ? { cursor } : {});
      if (
        !Array.isArray(listed?.tools) ||
        listed.tools.some(tool => !tool || typeof tool.name !== 'string' || tool.name.length > 128) ||
        tools.length + listed.tools.length > 1000
      )
        throw new Error('Unreal MCP returned an invalid or oversized tool inventory.');
      tools.push(...listed.tools);
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor) || page === 9)
        throw new Error('Unreal MCP tool pagination exceeded its bounds.');
      cursors.add(cursor);
    }
    if (new Set(tools.map(tool => tool.name)).size !== tools.length)
      throw new Error('Unreal MCP returned duplicate tools.');
    report.tools = tools;
    if (tools.some(tool => tool.name === 'list_toolsets')) {
      report.toolsetCatalog = toolText(await request('tools/call', { name: 'list_toolsets', arguments: {} }));
      const names = [...report.toolsetCatalog.matchAll(/^- ([a-zA-Z0-9_.]+)(?::|\s*$)/gm)].map(match => match[1]);
      report.sceneToolsetName = sceneToolsets.find(name => names.includes(name));
      report.sceneToolsetAvailable = !!report.sceneToolsetName;
      if (report.sceneToolsetAvailable && tools.some(tool => tool.name === 'describe_toolset')) {
        report.sceneToolsetDescription = toolText(
          await request('tools/call', {
            name: 'describe_toolset',
            arguments: { toolset_name: report.sceneToolsetName },
          }),
        );
      }
    } else {
      report.sceneToolsetName = sceneToolsets.find(name =>
        tools.some(tool => tool.name === `${name}.get_current_level`),
      );
      report.sceneToolsetAvailable = !!report.sceneToolsetName;
    }
    report.passed = true;
  } catch (error) {
    report.error = ['TimeoutError', 'AbortError'].includes(error.name)
      ? 'Unreal MCP discovery timed out; no retry was performed.'
      : error.message === 'fetch failed'
        ? 'Unreal MCP endpoint is unreachable; start the server in Unreal.'
        : error.message;
  } finally {
    if (session) {
      try {
        const response = await fetch(endpoint, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocolVersion },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        report.sessionClosed = response.ok;
      } catch {}
      if (!report.sessionClosed) {
        report.passed = false;
        report.cleanupError = 'Diagnostic MCP session could not be closed; no editor operation was dispatched.';
      }
    }
  }
  return report;
}
