// An agent's face (the design system's AgentAvatar): agent-kit.js draws the look's layers, and bundle.css moves
// them with the agent's state, each face in its own rhythm. Working rings it. Every face in the app is drawn here,
// so a change to the faces' motion reaches them all. Always shown beside the agent's name, so it is hidden from
// assistive technology unless it is the only place the name appears.
import type { CSSProperties } from 'react';
import { build, rhythm, VIEWBOX, type AgentLook, type AgentState, type KitPath } from './agent-kit.js';

const paths = (layer: KitPath[]) =>
  layer.map((path, index) => (
    <path
      key={index}
      d={path.d}
      fill={path.fill}
      stroke={path.stroke}
      strokeWidth={path.sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ));

export function AgentAvatar({
  look,
  state = 'idle',
  size = 48,
  label,
  ring = true,
}: {
  look: AgentLook;
  state?: AgentState;
  size?: number;
  label?: string;
  /** False leaves the working ring off where the face is small. */
  ring?: boolean;
}) {
  const layers = build(look, state),
    { delay, tempo } = rhythm(look),
    ringed = ring && state === 'working',
    timing = { '--sd-avatar-delay': `${delay}s`, '--sd-avatar-tempo': tempo } as CSSProperties;
  const face = (
    <svg
      className="sd-avatar"
      data-state={state}
      width={size}
      height={size}
      viewBox={VIEWBOX}
      style={ringed ? undefined : timing}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <g className="sd-avatar__whole">
        {paths(layers.body)}
        <g transform={layers.dy}>
          <g className="sd-avatar__top">{paths(layers.top)}</g>
        </g>
        {paths(layers.brows)}
        <g className="sd-avatar__eyes">
          {paths(layers.eyes)}
          <g className="sd-avatar__pupils">{paths(layers.pupils)}</g>
        </g>
        <g className="sd-avatar__mouth">{paths(layers.mouth)}</g>
        <g className="sd-avatar__mouth-alt">{paths(layers.mouthAlt)}</g>
        {paths(layers.detail)}
      </g>
    </svg>
  );
  return ringed ? (
    <span className="sd-avatar-ring" style={{ ...timing, borderRadius: `${Math.round(size * 0.3)}px` }}>
      {face}
    </span>
  ) : (
    face
  );
}
