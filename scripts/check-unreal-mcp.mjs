// Opt-in connection discovery. No model calls, editor tool calls, or studio DB access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectUnrealMcp } from '../src/unreal-discovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args[0] !== '--telemetry-disabled' || args.length > 2)
    throw new Error(
      'Usage: node scripts/check-unreal-mcp.mjs --telemetry-disabled [http://127.0.0.1:8000/mcp]\nFirst run ModelContextProtocol.EnableAnalytics 0 in Unreal. This flag records your confirmation, not an independently verified setting.',
    );
  const result = await inspectUnrealMcp({ endpoint: args[1], telemetryDisabled: true });
  const directory = fs.mkdtempSync(path.join(root, '.studio-unreal-'));
  fs.writeFileSync(path.join(directory, 'discovery.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        passed: result.passed,
        connected: result.connected,
        endpoint: result.endpoint,
        server: result.server,
        serverIdentity: result.serverIdentity,
        tools: result.tools?.map(tool => tool.name),
        sceneToolsetAvailable: result.sceneToolsetAvailable,
        telemetry: result.telemetry,
        sessionClosed: result.sessionClosed,
        editorMutation: result.editorMutation,
        projectIdentity: result.projectIdentity,
        error: result.error,
        cleanupError: result.cleanupError,
        evidenceDirectory: directory,
      },
      null,
      2,
    ),
  );
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
