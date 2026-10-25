// The agent kit is the design system's own file. These checks pin what a stored look means, so the dashboard
// draws the same faces as the canvas: the parts in each slot keep their order (new parts go at the end), and the
// picks for a project come out as the canvas shows them.
import { describe, expect, it } from 'vitest';
import { CLASSIC, SLOTS, STATES, build, partsApart, pickNew, rhythm, team } from './agent-kit.js';

describe('agent kit', () => {
  it('keeps every slot’s parts in order, so a stored look always draws the same face', () => {
    expect(Object.fromEntries(SLOTS.map(([key, parts]) => [key, parts.map(part => part[0])]))).toEqual({
      body: ['Box', 'Tall', 'Bean', 'Disc', 'Capsule', 'Dome', 'Wide', 'Egg', 'Jelly', 'Hex'],
      color: ['Orange', 'Violet', 'Pink', 'Mint', 'Sun', 'Sky', 'Coral', 'Lime', 'Lilac', 'Slate'],
      eyes: ['Dots', 'Visor', 'Glasses', 'One eye', 'Beads', 'Ovals', 'Shades', 'Pixels', 'Brows', 'Sparkle'],
      mouth: ['Smile', 'Flat', 'Hmm', 'Wide', 'Grin', 'Oh', 'Smirk', 'Cat', 'Tongue', 'Buck'],
      top: ['None', 'Antenna', 'Nib', 'Bolts', 'Sprout', 'Beanie', 'Tuft', 'Headphones', 'Bow', 'Propeller'],
      detail: [
        'None',
        'Cheeks',
        'Freckles',
        'Blush lines',
        'Bandage',
        'Mustache',
        'Whiskers',
        'Star',
        'Heart',
        'Bow tie',
      ],
    });
    expect(CLASSIC.map(agent => agent.name)).toEqual(['Mara', 'Eli', 'Morgan', 'Avery', 'Juno']);
  });

  it('picks the same team for a project as the canvas shows', () => {
    expect(team('To-do list sample', ['Planner', 'Engineer', 'Reviewer', 'Checks'])).toEqual([
      { name: 'Bea', role: 'Planner', look: { body: 2, color: 3, eyes: 7, mouth: 2, top: 4, detail: 1 } },
      { name: 'Nico', role: 'Engineer', look: { body: 9, color: 5, eyes: 2, mouth: 5, top: 6, detail: 2 } },
      { name: 'Yara', role: 'Reviewer', look: { body: 3, color: 8, eyes: 0, mouth: 3, top: 6, detail: 8 } },
      { name: 'Fern', role: 'Checks', look: { body: 8, color: 1, eyes: 9, mouth: 2, top: 1, detail: 0 } },
    ]);
  });

  it('keeps a new agent at least three parts from the others in its project, in a color of its own', () => {
    const taken = CLASSIC.slice(0, 4).map(agent => agent.look),
      look = pickNew('Studio desk development#Writer', taken);
    for (const other of taken) {
      expect(partsApart(look, other)).toBeGreaterThanOrEqual(3);
      expect(look.color).not.toBe(other.color);
    }
  });

  it('draws every state, and done and stuck in the agent’s own eye style', () => {
    const oneEye = { ...CLASSIC[0]!.look, eyes: 3 };
    for (const [state] of STATES) expect(build(oneEye, state).body.length).toBeGreaterThan(0);
    // One eye closes to a single arc when done, and keeps a single eye with its lid when stuck.
    expect(build(oneEye, 'done').eyes).toHaveLength(1);
    expect(build(oneEye, 'stuck').eyes).toHaveLength(2);
    expect(build(oneEye, 'stuck').pupils).toHaveLength(1);
  });

  it('gives each face its own rhythm from its look, so faces side by side never blink in step', () => {
    const rhythms = CLASSIC.map(agent => rhythm(agent.look));
    expect(rhythm(CLASSIC[0]!.look)).toEqual(rhythms[0]);
    for (const { delay, tempo } of rhythms) {
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThan(-4.2);
      expect(tempo).toBeGreaterThanOrEqual(0.9);
      expect(tempo).toBeLessThanOrEqual(1.1);
    }
    expect(new Set(rhythms.map(item => `${item.delay}/${item.tempo}`)).size).toBe(rhythms.length);
  });
});
