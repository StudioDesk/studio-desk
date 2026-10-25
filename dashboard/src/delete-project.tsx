// Delete this project (v1.0 item 24, the director October 24: "Add deleting to 1.0"): the controller removes the
// project and everything it recorded for it, and a sample's folder in the data folder, but never a repository or
// folder the director chose. It refuses while the project's work runs or an integration is open. The director types
// the project's name back to confirm; after the last project, No projects yet opens.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { send } from './api';
import { Modal } from './dialog';
import { rememberedProject } from './frame';
import { useToast } from './toast';

export function DeleteProject({ projectId, name }: { projectId: string; name: string }) {
  const [open, setOpen] = useState(false),
    [typed, setTyped] = useState(''),
    queryClient = useQueryClient(),
    navigate = useNavigate(),
    toast = useToast();
  const remove = useMutation({
    mutationFn: () =>
      send<{ deleted: string; folderRemoved: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/delete`, {
        projectId,
        name: typed.trim(),
      }),
    onSuccess: async ({ folderRemoved }) => {
      try {
        if (localStorage.getItem(rememberedProject) === projectId) localStorage.removeItem(rememberedProject);
      } catch {
        // Without browser storage the home page opens the first project anyway.
      }
      setOpen(false);
      toast(folderRemoved ? `Deleted ${name} and its sample folder.` : `Deleted ${name}.`);
      // The home page opens the first project it knows of, so the list it read before is dropped and read again;
      // other projects' records, whose rails list this one, are read again too.
      queryClient.removeQueries({ predicate: query => query.queryKey.includes(projectId) });
      queryClient.removeQueries({ queryKey: ['projects'] });
      void navigate({ to: '/', search: {} });
      void queryClient.invalidateQueries();
    },
  });
  const close = () => {
    setOpen(false);
    setTyped('');
    remove.reset();
  };
  const matches = typed.trim() === name;
  return (
    <>
      <button type="button" className="sd-btn sd-btn--danger sd-btn--sm" onClick={() => setOpen(true)}>
        Delete project
      </button>
      <Modal open={open} onClose={close} closable={!remove.isPending} title={`Delete ${name}?`}>
        <div className="sd-dialog__scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
          <p style={{ margin: 0 }}>
            This removes the project and everything Studio desk recorded for it: its board, ideas, attempts and the
            files they made. It can’t be undone.
          </p>
          <p className="sd-meta" style={{ margin: 0 }}>
            A sample’s folder in your Studio desk data folder is deleted too. A repository or folder you chose keeps
            everything, including the commits the pipeline made. Work that is running has to stop first: pause the
            project and wait for it.
          </p>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="delete-project-name">
              Type <span className="sd-mono">{name}</span> to confirm
            </label>
            <input
              id="delete-project-name"
              className="sd-input"
              autoComplete="off"
              value={typed}
              disabled={remove.isPending}
              onChange={event => setTyped(event.target.value)}
            />
          </div>
          {remove.error && (
            <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
              {remove.error.message}
            </p>
          )}
        </div>
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--danger"
            disabled={!matches || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Deleting…' : 'Delete project'}
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" disabled={remove.isPending} onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>
    </>
  );
}
