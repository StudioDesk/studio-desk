// Types for agent-kit.js, the design system's agent faces (AgentAvatar). The .js file is the design system's own,
// copied unchanged, so the canvas, the design system and the dashboard draw the same faces.

/** One path of a face, drawn with round caps and joins. */
export interface KitPath {
  d: string;
  fill: string;
  stroke: string;
  sw: number;
}
/** A face as six part numbers, each 0-9. An agent stores its look when it is created. */
export interface AgentLook {
  body: number;
  color: number;
  eyes: number;
  mouth: number;
  top: number;
  detail: number;
}
export type AgentState = 'idle' | 'working' | 'talking' | 'thinking' | 'done' | 'stuck';
/** A look's layers, in drawing order; `dy` is the transform for the top layer. */
export interface Layers {
  body: KitPath[];
  top: KitPath[];
  dy: string;
  brows: KitPath[];
  eyes: KitPath[];
  pupils: KitPath[];
  mouth: KitPath[];
  mouthAlt: KitPath[];
  detail: KitPath[];
}
type Part = readonly [name: string, ...rest: unknown[]];

export const VIEWBOX: string;
export const INK: string;
export const COLORS: readonly (readonly [name: string, hex: string])[];
export const BODIES: readonly Part[];
export const EYES: readonly Part[];
export const MOUTHS: readonly Part[];
export const TOPS: readonly Part[];
export const DETAILS: readonly Part[];
export const SLOTS: readonly (readonly [key: keyof AgentLook, parts: readonly Part[]])[];
export const STATES: readonly (readonly [id: AgentState, label: string, meaning: string])[];
export const NAMES: readonly string[];
export const CLASSIC: readonly { name: string; role: string; look: AgentLook }[];

export function build(look: AgentLook, state?: AgentState): Layers;
/** A face's own rhythm: where it starts in the motion cycles (seconds, zero or less) and how fast it runs them. */
export function rhythm(look: AgentLook): { delay: number; tempo: number };
export function hash(text: string): number;
export function rng(seed: number): () => number;
export function pickLook(rand: () => number): AgentLook;
export function partsApart(a: AgentLook, b: AgentLook): number;
export function pickNew(seedText: string, taken?: AgentLook[]): AgentLook;
export function pickName(seedText: string, taken?: string[]): string;
export function team(
  project: string,
  roles: string[],
  salt?: number,
): { name: string; role: string; look: AgentLook }[];
