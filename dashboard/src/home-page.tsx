// Pieces the pages share from the first Home: an agent's name and the warning while continuous cycles are on. Today
// itself is today-page.tsx.
import { useMutation } from '@tanstack/react-query';
import { send, type Shell } from './api';
import { workerName } from './names';
import { useToast } from './toast';

export { workerName };

// Continuous cycles are hidden in 1.0 (item 6); a saved policy with them on says so and turns them off.
export function CycleWarning({ projectId, state }: { projectId: string; state: Pick<Shell, 'autonomy'> }) {
  const toast = useToast(),
    policy = state.autonomy?.policy;
  const turnOff = useMutation({
    mutationFn: () =>
      send(`/api/projects/${encodeURIComponent(projectId)}/autonomy`, {
        projectId,
        expectedRevision: policy?.revision,
        enabled: policy?.enabled,
        retries: policy?.retries,
        kinds: policy?.kinds,
        cycle: { ...policy?.cycle, enabled: false },
      }),
    onError: error => toast(error.message),
  });
  if (!policy?.cycle?.enabled) return null;
  return (
    <div
      className="sd-card"
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-10)',
        padding: 'var(--space-14) 18px',
      }}
    >
      <span style={{ flex: '1 1 320px' }}>
        Continuous cycles are on. They are hidden in 1.0 because they can repeat work.
      </span>
      <button type="button" className="sd-btn sd-btn--sm" disabled={turnOff.isPending} onClick={() => turnOff.mutate()}>
        Turn off continuous cycles
      </button>
    </div>
  );
}
