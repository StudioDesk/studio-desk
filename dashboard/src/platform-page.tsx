// The platform map (v1.0 item 23; built in the redesign's language): how this project's teams, kinds of work,
// workflows, command-line tools and connectors connect, read only from what the controller exposes. The names here
// are the records' own, one click down from the pages that say them in words. Nothing here grants an agent anything;
// what the controller does not expose is said to be unknown.
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Shell, Worker } from './api';
import { Heading } from './layout';
import { useShell } from './records';

function Card({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby={id}>
      <h2 id={id} className="sd-sidecard__title">
        {title}
      </h2>
      {note && <span className="sd-meta">{note}</span>}
      <div>{children}</div>
    </section>
  );
}

function Row({ title, id, chip, children }: { title: string; id?: string; chip?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sd-row">
      <span className="sd-row__text" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
          <b>{title}</b>
          {id && <span className="sd-file">{id}</span>}
          {chip}
        </span>
        {children}
      </span>
    </div>
  );
}

const unknown = 'not exposed';

export function PlatformPage({ projectId }: { projectId: string }) {
  const { data: shell, error } = useShell(projectId);
  const head = (
    <Heading
      crumbs={[
        <Link key="settings" to="/p/$projectId/settings" params={{ projectId }}>
          Settings
        </Link>,
      ]}
      here="Platform map"
      title="Platform map"
      lead="How this project's teams, kinds of work, workflows and tools connect, as the controller records them. Nothing here grants an agent anything."
    />
  );
  if (!shell)
    return (
      <div className="sd-orgpage">
        {head}
        {error ? (
          <p role="alert">The project could not be loaded: {error.message}</p>
        ) : (
          <p role="status" className="sd-meta">
            Reading the project…
          </p>
        )}
      </div>
    );
  return (
    <div className="sd-orgpage">
      {head}
      <Connections shell={shell} />
    </div>
  );
}

function Connections({ shell }: { shell: Shell }) {
  const members = shell.workers,
    kinds = Object.entries(shell.taskKinds),
    enabled = kinds.filter(([, definition]) => definition.available === true),
    owners = shell.organizationConfiguration?.kindOwners ?? shell.kindOwners ?? {},
    name = (id?: string | null) =>
      id ? (members.find(item => item.id === id)?.displayName ?? `${id}, not in this project`) : unknown;
  const inTeam = (worker: Worker, teamId: string, teamName: string) =>
    worker.teamId ? worker.teamId === teamId : worker.team === teamName;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
      <Card
        id="map-kinds"
        title="Kinds of work this project takes"
        note={`${enabled.length} of the ${kinds.length} kinds the controller knows.`}
      >
        {enabled.map(([kind, definition]) => {
          const operation = definition.operation,
            registered =
              !!operation &&
              (shell.operations ?? []).some(
                entry => entry.connectorId === operation.connector && entry.id === operation.operation,
              );
          return (
            <Row key={kind} title={definition.label ?? kind} id={kind}>
              <span className="sd-meta">
                From {definition.packId ?? 'an unknown pack'} · goes to{' '}
                {owners[kind] ? name(owners[kind]) : 'the agent each piece of work names'} · runs on{' '}
                {definition.executionAdapter ?? "the agent's own command-line tool"}
              </span>
              {operation && (
                <span className="sd-meta">
                  Operation {operation.connector ?? unknown} → {operation.operation ?? unknown} (
                  {registered ? 'registered' : 'not registered'}), {operation.inputContract ?? unknown} →{' '}
                  {operation.outputContract ?? unknown}
                </span>
              )}
            </Row>
          );
        })}
      </Card>
      <Card id="map-workflows" title="Workflows">
        {shell.workflows.length ? (
          shell.workflows.map(workflow => (
            <Row key={workflow.id} title={workflow.name} id={workflow.id}>
              {workflow.description && <span className="sd-meta">{workflow.description}</span>}
              <ol style={{ margin: 0, paddingLeft: '1.2em', color: 'var(--ink-2)', fontSize: '14px' }}>
                {(workflow.graph?.nodes ?? []).map(node => {
                  const after = (workflow.graph?.edges ?? [])
                    .filter(edge => edge.to === node.key)
                    .map(edge => edge.from);
                  return (
                    <li key={node.key}>
                      {node.title} <span className="sd-file">{node.kind ?? unknown}</span>,{' '}
                      {node.role ? `by a ${node.role}` : `by ${name(node.workerId)}`}
                      {after.length ? `, after ${after.join(' and ')}` : ''}
                    </li>
                  );
                })}
              </ol>
            </Row>
          ))
        ) : (
          <span className="sd-meta">No workflows.</span>
        )}
      </Card>
      <Card id="map-teams" title="Teams and their agents">
        {(shell.teams ?? []).map(team => {
          const people = members.filter(worker => inTeam(worker, team.id, team.name));
          return (
            <Row key={team.id} title={team.name} id={team.id}>
              {team.purpose && <span className="sd-meta">{team.purpose}</span>}
              {people.length ? (
                people.map(worker => (
                  <span key={worker.id} className="sd-meta">
                    <b style={{ color: 'var(--ink)' }}>{worker.displayName ?? worker.id}</b> ({worker.id}),{' '}
                    {worker.role || worker.jobTitle || 'no role'}, on {worker.provider || unknown}
                  </span>
                ))
              ) : (
                <span className="sd-meta">No agents in this team.</span>
              )}
            </Row>
          );
        })}
      </Card>
      <Card id="map-tools" title="Command-line tools" note="Shared by every project on this computer.">
        {Object.values(shell.adapters ?? {}).map(adapter => (
          <Row
            key={adapter.id}
            title={adapter.name}
            id={adapter.id}
            chip={
              <span className={`sd-chip sd-chip--inline${adapter.available ? ' sd-chip--ok' : ''}`}>
                <span className="sd-chip__dot"></span>
                {adapter.available === true ? 'Found' : adapter.available === false ? 'Not found' : 'Unknown'}
              </span>
            }
          >
            <span className="sd-meta">
              {Array.isArray(adapter.capabilities) && adapter.capabilities.length
                ? `It can ${adapter.capabilities.join(', ')}.`
                : 'Its capabilities are not exposed.'}
            </span>
          </Row>
        ))}
      </Card>
      <Card
        id="map-connectors"
        title="Connectors and operations"
        note="Shared by every project. Which tool reaches which connector, and which projects may use it, is not exposed yet."
      >
        {(shell.operations ?? []).length ? (
          (shell.operations ?? []).map(operation => (
            <Row
              key={`${operation.connectorId}:${operation.id}`}
              title={`${operation.connectorId ?? unknown} → ${operation.id ?? unknown}`}
            >
              <span className="sd-meta">
                {operation.capability ?? unknown} · {operation.inputContract ?? unknown} →{' '}
                {operation.outputContract ?? unknown} · scope {operation.scope ?? unknown}
              </span>
            </Row>
          ))
        ) : (
          <span className="sd-meta">No connectors registered.</span>
        )}
      </Card>
    </div>
  );
}
