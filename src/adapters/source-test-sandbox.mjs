// Fixed, command-local permissions. Never modify the director's CLI config.
export const sourceTestSandboxProfile = 'studio-source-tests';
export function sourceTestCommand(binary, plan, implementation) {
  const args = [
    'sandbox',
    '--include-managed-config',
    '--permission-profile',
    sourceTestSandboxProfile,
    '--cd',
    plan.root,
    '--config',
    'permissions.studio-source-tests.extends=":workspace"',
    '--config',
    'permissions.studio-source-tests.network.enabled=true',
    '--config',
    'permissions.studio-source-tests.network.allow_local_binding=true',
    '--config',
    'permissions.studio-source-tests.network.allow_upstream_proxy=false',
    '--config',
    'permissions.studio-source-tests.network.domains={"127.0.0.1"="allow","localhost"="allow"}',
    '--config',
    'features.network_proxy=true',
  ];
  if (process.platform === 'win32') args.push('--config', `windows.sandbox="${implementation}"`);
  args.push('--', plan.command.executable, ...plan.command.args);
  return { executable: binary, args };
}

// Where candidate tests and integration verification run (v1.0 item 20): in the Codex CLI sandbox,
// the default, or, by the director's explicit choice, directly on this computer with the director's
// own access, so no single CLI is required to change code. Each attempt records the choice; an
// attempt recorded before the choice existed used the Codex sandbox.
export const testSandboxes = ['codex', 'none'];
export const testSandboxOf = configuration => configuration?.testSandbox || 'codex';
// Where the next attempt's candidate tests run (v1.0 item 25): the director's choice, or with none made,
// the Codex sandbox where Codex CLI is installed and otherwise this computer, so one signed-in CLI runs
// every step. Attempts record the result, so a change here never alters what an earlier attempt ran with.
export const chosenTestSandbox = (organization, codexBinary) =>
  organization?.testSandbox || (codexBinary ? 'codex' : 'none');
export function candidateTestCommand(binary, plan, configuration) {
  return testSandboxOf(configuration) === 'none'
    ? structuredClone(plan.command)
    : sourceTestCommand(binary, plan, configuration?.windowsSandbox);
}
// How a check's evidence names where the tests ran, so the dashboard shows it.
export const sandboxLabel = configuration =>
  testSandboxOf(configuration) === 'none' ? 'without a sandbox' : 'in the Codex sandbox';
export function sandboxRecord(configuration) {
  return testSandboxOf(configuration) === 'none'
    ? { provider: 'none', network: 'unrestricted' }
    : {
        provider: 'codex',
        implementation: configuration?.windowsSandbox || 'platform default',
        profile: sourceTestSandboxProfile,
        network: 'loopback-tests',
      };
}
