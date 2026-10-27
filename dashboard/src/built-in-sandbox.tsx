// The built-in sandbox's one-time setup on this computer (1.0.1), on Settings → Candidate tests and on No projects
// yet. On Windows the setup asks for an administrator, so the director answers Windows' own prompt; on Linux it
// installs the system packages the sandbox needs, through the system's password prompt where there is one, and
// shows the command to run in a terminal; macOS needs none. The card refreshes the page's query, which carries
// the sandbox's state, until the setup has finished.
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import { send, type BuiltInSandbox } from './api';
import { useToast } from './toast';

const listed = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

export function BuiltInSandboxSetup({
  projectId,
  sandbox,
  queryKey,
}: {
  projectId?: string;
  sandbox: BuiltInSandbox;
  queryKey: QueryKey;
}) {
  const toast = useToast(),
    client = useQueryClient(),
    running = sandbox.setup?.state === 'running',
    failed = sandbox.setup?.state === 'failed';
  const setup = useMutation({
    mutationFn: () => send('/api/built-in-sandbox', projectId ? { projectId } : {}),
    onSuccess: () => client.invalidateQueries({ queryKey }),
    onError: error => toast(error.message),
  });
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => client.invalidateQueries({ queryKey }), 2000);
    return () => clearInterval(timer);
  }, [client, queryKey, running]);
  if (sandbox.state === 'unsupported') return null;
  if (sandbox.state === 'missing')
    return (
      <span className="sd-meta">
        The built-in sandbox isn’t installed with this copy of Studio desk. Run <span className="sd-mono">npm ci</span>{' '}
        in its folder, then restart the controller.
      </span>
    );
  if (sandbox.state === 'ready')
    return (
      <span className="sd-chip sd-chip--ok" style={{ alignSelf: 'flex-start' }}>
        <span className="sd-chip__dot"></span>Built-in sandbox ready on this computer
      </span>
    );
  const lastLine = sandbox.setup?.output?.split(/\r?\n/).filter(Boolean).at(-1),
    didNotFinish = `The setup didn’t finish${lastLine ? `: ${lastLine}` : '.'}`;
  if (sandbox.needs) {
    const { command } = sandbox,
      copy = (text: string) =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => toast('Copied the command.'))
          .catch(() => toast('Select the command to copy it.'));
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
        <span className="sd-meta">
          {running
            ? 'Your system is asking for your password. Answer its prompt to finish.'
            : failed
              ? didNotFinish
              : `One-time setup on this computer: the sandbox needs ${listed(sandbox.needs)} from your system’s packages.`}
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-10)', alignItems: 'center' }}>
          {sandbox.prompt ? (
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              disabled={running || setup.isPending}
              onClick={() => setup.mutate()}
            >
              {running ? 'Setting up…' : failed ? 'Try again' : 'Set up the sandbox'}
            </button>
          ) : (
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              onClick={() => void client.invalidateQueries({ queryKey })}
            >
              Check again
            </button>
          )}
          <span className="sd-meta" style={{ flex: '1 1 260px' }}>
            {command
              ? sandbox.prompt
                ? 'Or install them in a terminal:'
                : 'Install them in a terminal, then check again:'
              : `Install ${listed(sandbox.needs)} with your system’s package manager, then check again.`}
          </span>
        </span>
        {command && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-10)', alignItems: 'center' }}>
            <code className="sd-mono" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
              {command}
            </code>
            <button type="button" className="sd-btn sd-btn--sm" onClick={() => void copy(command)}>
              Copy
            </button>
          </span>
        )}
      </span>
    );
  }
  const update = sandbox.state === 'outdated';
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-10)', alignItems: 'center' }}>
      <button
        type="button"
        className="sd-btn sd-btn--sm"
        disabled={running || setup.isPending}
        onClick={() => setup.mutate()}
      >
        {running ? 'Setting up…' : failed ? 'Try again' : update ? 'Update the sandbox' : 'Set up the sandbox'}
      </button>
      <span className="sd-meta" style={{ flex: '1 1 260px' }}>
        {running
          ? 'Windows is asking for an administrator. Answer its prompt to finish.'
          : failed
            ? didNotFinish
            : update
              ? 'This version of Studio desk needs the sandbox set up again. Windows asks for an administrator once.'
              : 'One-time setup on this computer. Windows asks for an administrator, then adds a local account for tests and a network filter for it.'}
      </span>
    </span>
  );
}
