// Agent kit: every agent's face, built from parts on a 40-unit grid.
// Plain data and functions with no dependencies, so the design canvas and the dashboard draw the same faces.
//
// A look is six part numbers: { body, color, eyes, mouth, top, detail }, each 0-9. An agent stores its look
// when it is created, so a face never changes on its own. New parts are only ever added at the end of a list,
// never inserted or reordered, so every stored look keeps meaning the same face.
//
// Draw a look with build(look, state). It returns layers of paths ({ d, fill, stroke, sw }), drawn in this order
// inside <svg viewBox={VIEWBOX}>, every path with stroke-linecap and stroke-linejoin "round":
//   whole   -> body, then top (inside a group translated by dy), brows, eyes (with pupils), mouth, mouthAlt, detail
// The motion is CSS on named groups (whole, top, eyes, pupils, mouth, mouth-alt), keyed by the state.

export const VIEWBOX = '-2 -4 44 46';
export const INK = '#1D1B33';
const WHITE = '#FFFFFF',
  GLOW = '#9EF0FF',
  LEAF = '#3CCB83',
  BLUSH = '#FF9EC4',
  SOFT = 'rgba(29,27,51,.42)';
const PLASTER = '#F6D3A8',
  GOLD = '#FFD23F',
  HEART = '#FF5A7A',
  STEM = '#2E9E68',
  STEEL = '#D9D6E8';

const n = v => Math.round(v * 100) / 100;
const rr = (x, y, w, h, r) =>
  `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(h - 2 * r)}a${r} ${r} 0 0 1 -${r} ${r}h-${n(w - 2 * r)}a${r} ${r} 0 0 1 -${r} -${r}v-${n(h - 2 * r)}a${r} ${r} 0 0 1 ${r} -${r}z`;
const circ = (cx, cy, r) => `M${n(cx - r)} ${n(cy)}a${r} ${r} 0 1 0 ${n(2 * r)} 0a${r} ${r} 0 1 0 -${n(2 * r)} 0z`;
const ell = (cx, cy, rx, ry) =>
  `M${n(cx - rx)} ${n(cy)}a${rx} ${ry} 0 1 0 ${n(2 * rx)} 0a${rx} ${ry} 0 1 0 -${n(2 * rx)} 0z`;
const star = (cx, cy, R, r) =>
  'M' +
  Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5,
      k = i % 2 ? r : R;
    return `${n(cx + k * Math.cos(a))} ${n(cy + k * Math.sin(a))}`;
  }).join('L') +
  'z';
const F = (d, fill) => ({ d, fill, stroke: 'none', sw: 0 });
const S = (d, stroke, sw) => ({ d, fill: 'none', stroke: stroke || INK, sw: sw || 2 });
const FS = (d, fill, sw) => ({ d, fill, stroke: INK, sw: sw || 2 });

// Eye helpers: a closed happy arc, and a lid that covers the top half of an eye.
const arc = (cx, cy, w, color, sw) =>
  S(`M${n(cx - w / 2)} ${n(cy + 1)}q${n(w / 2)} ${-n(w * 0.64)} ${n(w)} 0`, color || INK, sw || 2.4);
const pair = (f, ...a) => [f(14, ...a), f(26, ...a)];
const lid = (cx, cy, rx, ry) => F(`M${n(cx - rx)} ${n(cy)}a${rx} ${ry ?? rx} 0 0 1 ${n(2 * rx)} 0z`, INK);
const dot = (cx, cy, r, fill) => F(circ(cx, cy, r), fill);

export const COLORS = [
  ['Orange', '#FF8A3D'],
  ['Violet', '#7B61FF'],
  ['Pink', '#F0629B'],
  ['Mint', '#2BBF95'],
  ['Sun', '#FFD23F'],
  ['Sky', '#3DB5F0'],
  ['Coral', '#FF7A6B'],
  ['Lime', '#9BD84A'],
  ['Lilac', '#B98CFF'],
  ['Slate', '#8A93B8'],
];
// The second color toppers and details use: yellow on most bodies, pink on the yellow and green ones.
const accentFor = hex => (['#FFD23F', '#9BD84A'].includes(hex) ? '#F0629B' : '#FFD23F');

// [name, draw(color), how far the head's top sits from the Box's (toppers move with it), how far the sides are inset]
export const BODIES = [
  ['Box', c => [F(rr(2, 6, 36, 32, 12), c)], 0, 0],
  ['Tall', c => [F(rr(2, 4, 36, 34, 11), c)], -2, 0],
  ['Bean', c => [F(rr(2, 5, 36, 33, 16), c)], -1, 0],
  ['Disc', c => [F(circ(20, 21, 18), c)], -3, 0],
  ['Capsule', c => [F(rr(6, 3, 28, 35, 14), c)], -3, 4],
  ['Dome', c => [F('M6 38a4 4 0 0 1-4-4V22a18 18 0 0 1 36 0v12a4 4 0 0 1-4 4z', c)], -2, 0],
  ['Wide', c => [F(rr(1, 10, 38, 28, 12), c)], 4, 0],
  ['Egg', c => [F('M20 4C31 4 38 18 38 26C38 34 30 38 20 38C10 38 2 34 2 26C2 18 9 4 20 4z', c)], -2, 3],
  ['Jelly', c => [F('M2 20a18 18 0 0 1 36 0v16q-3 3-6 0t-6 0-6 0-6 0-6 0-6 0z', c)], -4, 0],
  ['Hex', c => [{ d: 'M12.5 7.5h15l8 13.5-8 13.5h-15l-8-13.5z', fill: c, stroke: c, sw: 5 }], -1, 2],
];

// [name, draw(mood)] where mood is 'open', 'happy' (done) or 'sleepy' (stuck); each returns { eyes, pupils, brows }.
// Every style draws its own happy and sleepy versions, so a mood never swaps in another style's eyes.
export const EYES = [
  [
    'Dots',
    m =>
      m === 'happy'
        ? { eyes: pair(arc, 20, 7) }
        : m === 'sleepy'
          ? { eyes: [...pair(dot, 21, 4, WHITE), ...pair(lid, 21, 4)], pupils: pair(dot, 22.6, 1.6, INK) }
          : { eyes: pair(dot, 20, 4, WHITE), pupils: [dot(14.8, 20.6, 2, INK), dot(26.8, 20.6, 2, INK)] },
  ],
  [
    'Visor',
    m => {
      const band = F(rr(8, 14, 24, 10, 5), INK);
      return m === 'happy'
        ? { eyes: [band, arc(15, 19.4, 5.2, GLOW, 2), arc(25, 19.4, 5.2, GLOW, 2)] }
        : m === 'sleepy'
          ? { eyes: [band, S('M12.8 19.8h4.4', GLOW, 2.2), S('M22.8 19.8h4.4', GLOW, 2.2)] }
          : { eyes: [band], pupils: [dot(15, 19, 2.2, GLOW), dot(25, 19, 2.2, GLOW)] };
    },
  ],
  [
    'Glasses',
    m => {
      const frame = [FS(circ(13.5, 19, 5.5), WHITE), FS(circ(26.5, 19, 5.5), WHITE), S('M19 19h2')];
      return m === 'happy'
        ? { eyes: [...frame, arc(13.5, 19.4, 5.6), arc(26.5, 19.4, 5.6)] }
        : m === 'sleepy'
          ? {
              eyes: [...frame, lid(13.5, 19, 5.5), lid(26.5, 19, 5.5)],
              pupils: [dot(13.5, 21.3, 1.6, INK), dot(26.5, 21.3, 1.6, INK)],
            }
          : { eyes: frame, pupils: [dot(13.5, 19.5, 2, INK), dot(26.5, 19.5, 2, INK)] };
    },
  ],
  [
    'One eye',
    m =>
      m === 'happy'
        ? { eyes: [arc(20, 19.6, 12.8, INK, 2.6)] }
        : m === 'sleepy'
          ? { eyes: [dot(20, 19, 8, WHITE), lid(20, 19, 8)], pupils: [dot(20, 22.6, 2.6, INK)] }
          : { eyes: [dot(20, 19, 8, WHITE)], pupils: [dot(20, 19, 4, INK), dot(21.5, 17.5, 1.3, WHITE)] },
  ],
  [
    'Beads',
    m =>
      m === 'happy'
        ? { eyes: pair(arc, 20, 7) }
        : m === 'sleepy'
          ? { eyes: [F('M10.4 20.6a3.6 3.6 0 0 0 7.2 0z', INK), F('M22.4 20.6a3.6 3.6 0 0 0 7.2 0z', INK)] }
          : { eyes: pair(dot, 20, 3.6, INK), pupils: [dot(15, 19, 1.2, WHITE), dot(27, 19, 1.2, WHITE)] },
  ],
  [
    'Ovals',
    m =>
      m === 'happy'
        ? { eyes: pair(arc, 20.5, 6.4) }
        : m === 'sleepy'
          ? {
              eyes: [
                F(ell(14, 20.5, 3, 4.5), WHITE),
                F(ell(26, 20.5, 3, 4.5), WHITE),
                lid(14, 20.5, 3, 4.5),
                lid(26, 20.5, 3, 4.5),
              ],
              pupils: [F(ell(14, 22.6, 1.4, 1.7), INK), F(ell(26, 22.6, 1.4, 1.7), INK)],
            }
          : {
              eyes: [F(ell(14, 20, 3, 4.5), WHITE), F(ell(26, 20, 3, 4.5), WHITE)],
              pupils: [F(ell(14.6, 21, 1.6, 2.4), INK), F(ell(26.6, 21, 1.6, 2.4), INK)],
            },
  ],
  [
    'Shades',
    m => {
      const lenses = (y, h, r) => [F(rr(8, y, 10, h, r), INK), F(rr(22, y, 10, h, r), INK), S(`M18 ${n(y + 2.6)}h4`)];
      return m === 'happy'
        ? { eyes: [...lenses(15, 8, 3), arc(13, 19.4, 5.2, WHITE, 1.6), arc(27, 19.4, 5.2, WHITE, 1.6)] }
        : m === 'sleepy'
          ? { eyes: lenses(18, 5.5, 2.5) }
          : {
              eyes: lenses(15, 8, 3),
              pupils: [F(rr(10, 16.6, 3.4, 1.6, 0.8), WHITE), F(rr(24, 16.6, 3.4, 1.6, 0.8), WHITE)],
            };
    },
  ],
  [
    'Pixels',
    m =>
      m === 'happy'
        ? { eyes: [S('M10.6 22.4l3.4-3.4 3.4 3.4', INK, 2.4), S('M22.6 22.4l3.4-3.4 3.4 3.4', INK, 2.4)] }
        : m === 'sleepy'
          ? {
              eyes: [
                F(rr(10, 20, 8, 4, 1.2), WHITE),
                F(rr(22, 20, 8, 4, 1.2), WHITE),
                S('M9.6 20h8.8', INK, 2.4),
                S('M21.6 20h8.8', INK, 2.4),
              ],
              pupils: [F(rr(12.8, 20.9, 3, 2.3, 0.5), INK), F(rr(24.8, 20.9, 3, 2.3, 0.5), INK)],
            }
          : {
              eyes: [F(rr(10, 16, 8, 8, 1.5), WHITE), F(rr(22, 16, 8, 8, 1.5), WHITE)],
              pupils: [F(rr(13.4, 19.4, 3.6, 3.6, 0.6), INK), F(rr(25.4, 19.4, 3.6, 3.6, 0.6), INK)],
            },
  ],
  [
    'Brows',
    m =>
      m === 'happy'
        ? {
            eyes: pair(arc, 21, 6.6),
            brows: [S('M10.2 13.6q3.8-2.6 7.6-.6', INK, 2.2), S('M22.2 13q3.8-2 7.6.6', INK, 2.2)],
          }
        : m === 'sleepy'
          ? {
              eyes: [...pair(dot, 21.5, 3.6, WHITE), ...pair(lid, 21.5, 3.6)],
              pupils: pair(dot, 23, 1.5, INK),
              brows: [S('M10.4 16.4l7-1.6', INK, 2.2), S('M29.6 16.4l-7-1.6', INK, 2.2)],
            }
          : {
              eyes: pair(dot, 21, 3.6, WHITE),
              pupils: [dot(14.6, 21.6, 1.8, INK), dot(26.6, 21.6, 1.8, INK)],
              brows: [S('M10.2 15q3.8-2.6 7.6-.6', INK, 2.2), S('M22.2 14.4q3.8-2 7.6.6', INK, 2.2)],
            },
  ],
  [
    'Sparkle',
    m =>
      m === 'happy'
        ? { eyes: pair(arc, 20.4, 8) }
        : m === 'sleepy'
          ? { eyes: [...pair(dot, 20.5, 5, WHITE), ...pair(lid, 20.5, 5)], pupils: pair(dot, 23, 2.1, INK) }
          : {
              eyes: pair(dot, 20, 5, WHITE),
              pupils: [
                dot(14.5, 20.5, 3.2, INK),
                dot(26.5, 20.5, 3.2, INK),
                dot(15.9, 19, 1.2, WHITE),
                dot(27.9, 19, 1.2, WHITE),
                dot(13.3, 22.1, 0.6, WHITE),
                dot(25.3, 22.1, 0.6, WHITE),
              ],
            },
  ],
];

export const MOUTHS = [
  ['Smile', () => [S('M15 29q5 4 10 0')]],
  ['Flat', () => [S('M16 30h8')]],
  ['Hmm', () => [S('M16 30q4-2 8 0')]],
  ['Wide', () => [S('M14 31h12')]],
  ['Grin', () => [F('M14 28h12a6 6 0 0 1-12 0z', INK), F(rr(16.5, 28, 7, 2, 1), WHITE)]],
  ['Oh', () => [F(circ(20, 30, 2.4), INK)]],
  ['Smirk', () => [S('M16 30q5 2.5 9-1.5')]],
  ['Cat', () => [S('M15 29q2.5 2.5 5 0q2.5 2.5 5 0')]],
  ['Tongue', () => [F('M14 28h12a6 6 0 0 1-12 0z', INK), F(ell(20, 32, 3, 1.8), BLUSH)]],
  [
    'Buck',
    () => [
      S('M14 28.5q6 4 12 0'),
      FS(rr(17.2, 30, 2.8, 3.6, 0.8), WHITE, 1.2),
      FS(rr(20, 30, 2.8, 3.6, 0.8), WHITE, 1.2),
    ],
  ],
];
// While stuck, any mouth goes wobbly; while talking it alternates with an open oval.
const STUCK_MOUTH = [S('M15 30.6q1.7-1.8 3.3 0t3.4 0 3.3 0')];
const TALK_MOUTH = [F(ell(20, 30, 2.8, 2.2), INK)];

// [name, draw(accent, sideInset, bodyColor)], drawn for the Box's head and moved by the body's dy.
// Anything that leaves the body takes a color or an ink outline, never bare ink, so it reads on dark and light.
export const TOPS = [
  ['None', () => []],
  ['Antenna', (a, i, c) => [S('M20 7V2', c, 2.2), F(circ(20, 2.5, 2.2), a)]],
  ['Nib', a => [FS('M27 7l5-5 3 3-5 5z', a, 1.4)]],
  ['Bolts', (a, i) => [FS(rr(i, 16, 3, 8, 1.5), STEEL, 1.2), FS(rr(37 - i, 16, 3, 8, 1.5), STEEL, 1.2)]],
  ['Sprout', () => [S('M20 7V3', STEM, 2), F('M20 4q-5-3-7 1q5 2 7-1z', LEAF), F('M20 4q5-3 7 1q-5 2-7-1z', LEAF)]],
  ['Beanie', a => [F('M7 12a13 9 0 0 1 26 0z', a), F(rr(6, 10, 28, 4, 2), INK), F(circ(20, 2.6, 2.4), a)]],
  ['Tuft', (a, i, c) => [S('M17 8q-1-4 2-7', c, 2.4), S('M20 7q1-4 4-6', c, 2.4), S('M23 8q2-3 5-4', c, 2.4)]],
  [
    'Headphones',
    (a, i) => [
      S(`M${5 + i} 18a${15 - i} ${15 - i} 0 0 1 ${30 - 2 * i} 0`, a, 2.5),
      FS(rr(1 + i, 14, 6, 11, 3), a, 1.2),
      FS(rr(33 - i, 14, 6, 11, 3), a, 1.2),
    ],
  ],
  ['Bow', a => [F('M30 6l-5-3v6z', a), F('M30 6l5-3v6z', a), F(circ(30, 6, 1.6), INK)]],
  [
    'Propeller',
    (a, i, c) => [S('M20 7V3', c, 2), F(ell(16, 2.6, 4, 1.4), a), F(ell(24, 2.6, 4, 1.4), a), F(circ(20, 3, 1.3), INK)],
  ],
];
// Toppers that sit on the sides of the head, not its top, so they ignore the body's dy.
const SIDE_TOPS = ['Bolts', 'Headphones'];

// [name, draw(accent)], drawn last, over the face.
export const DETAILS = [
  ['None', () => []],
  ['Cheeks', () => [F(circ(9, 27, 2.4), BLUSH), F(circ(31, 27, 2.4), BLUSH)]],
  [
    'Freckles',
    () =>
      [
        [8.5, 26],
        [11, 27.3],
        [8.8, 28.7],
        [31.5, 26],
        [29, 27.3],
        [31.2, 28.7],
      ].map(([x, y]) => F(circ(x, y, 0.85), SOFT)),
  ],
  ['Blush lines', () => [S('M8 28.4l1.6-2.6M10.6 28.4l1.6-2.6M27.8 28.4l1.6-2.6M30.4 28.4l1.6-2.6', SOFT, 1.4)]],
  [
    'Bandage',
    () => [
      FS(rr(25.4, 25.6, 7.6, 3.4, 1.7), PLASTER, 1.2),
      F(circ(28.2, 27.3, 0.45), INK),
      F(circ(30.2, 27.3, 0.45), INK),
    ],
  ],
  [
    'Mustache',
    () => [
      F(
        'M20 26.8C18 25.4 15.5 25.6 14 27.2C13.2 28 12 27.8 11.6 26.8C11.8 29 14 30 16 29.2C17.6 28.6 19 28.2 20 28.6C21 28.2 22.4 28.6 24 29.2C26 30 28.2 29 28.4 26.8C28 27.8 26.8 28 26 27.2C24.5 25.6 22 25.4 20 26.8z',
        INK,
      ),
    ],
  ],
  ['Whiskers', () => [S('M4.5 27.2l5.5 .6M4.5 30.6l5.5-1M35.5 27.2l-5.5 .6M35.5 30.6l-5.5-1', INK, 1.4)]],
  ['Star', () => [FS(star(9.5, 27.4, 3.3, 1.45), GOLD, 1.1)]],
  ['Heart', () => [FS('M30.5 29.9l-3.1-3a1.8 1.8 0 0 1 3.1-1.5a1.8 1.8 0 0 1 3.1 1.5z', HEART, 1.1)]],
  ['Bow tie', a => [F('M20 36.6l-5.2-3.1v6.2z', a), F('M20 36.6l5.2-3.1v6.2z', a), F(circ(20, 36.6, 1.5), INK)]],
];

// The parts a look picks from, in the order a look lists them.
export const SLOTS = [
  ['body', BODIES],
  ['color', COLORS],
  ['eyes', EYES],
  ['mouth', MOUTHS],
  ['top', TOPS],
  ['detail', DETAILS],
];

// The states an agent shows, each one a state the controller records.
export const STATES = [
  ['idle', 'Idle', 'Free. Blinks now and then.'],
  ['working', 'Working', 'Running an attempt. Bobs, with the live ring.'],
  ['talking', 'Talking', 'Writing a message to you.'],
  ['thinking', 'Thinking', 'A thinking pause the CLI reports.'],
  ['done', 'Done', 'Its work passed. Happy eyes, one small hop.'],
  ['stuck', 'Stuck', 'Stopped, with sleepy eyes; its card says why.'],
];

export function build(look, state = 'idle') {
  const color = COLORS[look.color][1],
    accent = accentFor(color);
  const [, drawBody, headDy, inset] = BODIES[look.body];
  const [topName, drawTop] = TOPS[look.top];
  const face = EYES[look.eyes][1](state === 'done' ? 'happy' : state === 'stuck' ? 'sleepy' : 'open');
  return {
    body: drawBody(color),
    top: drawTop(accent, inset, color),
    dy: `translate(0 ${SIDE_TOPS.includes(topName) ? 0 : headDy})`,
    brows: face.brows || [],
    eyes: face.eyes,
    pupils: face.pupils || [],
    mouth: state === 'stuck' ? STUCK_MOUTH : MOUTHS[look.mouth][1](),
    mouthAlt: TALK_MOUTH,
    detail: DETAILS[look.detail][1](accent),
  };
}

// A face's own rhythm, from its six numbers: where it starts in the shared motion cycles (delay, in seconds, zero
// or less) and how fast it runs them (tempo, 0.9 to 1.1 times). Faces side by side then never blink or bob in
// step, and each face keeps its rhythm wherever it is drawn. Set them on the svg as --sd-avatar-delay (with its
// unit) and --sd-avatar-tempo.
export function rhythm(look) {
  const number = SLOTS.reduce((total, [key]) => total * 10 + look[key], 0),
    mixed = Math.imul(number, 2654435761) >>> 0;
  return { delay: -(mixed % 4200) / 1000, tempo: (90 + ((mixed >>> 16) % 21)) / 100 };
}

// Deterministic picks: the same seed text always gives the same look and name.
export function hash(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function pickLook(rand) {
  return Object.fromEntries(SLOTS.map(([key, list]) => [key, Math.floor(rand() * list.length)]));
}
export function partsApart(a, b) {
  return SLOTS.filter(([key]) => a[key] !== b[key]).length;
}

// A new agent's look: at least 3 parts away from every look already in its project, and a color of its own
// while the project has fewer agents than there are colors.
export function pickNew(seedText, taken = []) {
  const rand = rng(hash(seedText));
  const clashes = look =>
    taken.some(t => partsApart(t, look) < 3 || (taken.length < COLORS.length && t.color === look.color));
  let look = pickLook(rand);
  for (let tries = 0; tries < 60 && clashes(look); tries++) look = pickLook(rand);
  return look;
}

export const NAMES = [
  'Pip',
  'Rook',
  'Tess',
  'Ivo',
  'Bram',
  'Nell',
  'Otto',
  'Wren',
  'Kit',
  'Remy',
  'Sol',
  'Fern',
  'Milo',
  'Ada',
  'Lux',
  'Hugo',
  'Bea',
  'Cass',
  'Nico',
  'Ori',
  'Moss',
  'Indy',
  'Quin',
  'Rue',
  'Sage',
  'Tam',
  'Yara',
  'Bo',
  'Zuri',
  'Lark',
];
export function pickName(seedText, taken = []) {
  const free = NAMES.filter(name => !taken.includes(name));
  const rand = rng(hash(seedText + '#name'));
  return free.length
    ? free[Math.floor(rand() * free.length)]
    : `${NAMES[Math.floor(rand() * NAMES.length)]} ${taken.length + 1}`;
}

// A project's agents, picked one at a time; adding an agent later never changes the ones before it.
// The salt is only for shuffling a team in the design canvas.
export function team(project, roles, salt = 0) {
  const members = [];
  roles.forEach((role, i) => {
    const seed = `${project}#${salt}#${role}#${i}`;
    members.push({
      name: pickName(
        seed,
        members.map(m => m.name),
      ),
      role,
      look: pickNew(
        seed,
        members.map(m => m.look),
      ),
    });
  });
  return members;
}

// Today's agents, rebuilt from the parts.
export const CLASSIC = [
  { name: 'Mara', role: 'Planner', look: { body: 0, color: 0, eyes: 0, mouth: 0, top: 1, detail: 0 } },
  { name: 'Eli', role: 'Engineer', look: { body: 1, color: 1, eyes: 1, mouth: 1, top: 3, detail: 0 } },
  { name: 'Morgan', role: 'Reviewer', look: { body: 2, color: 2, eyes: 2, mouth: 2, top: 0, detail: 0 } },
  { name: 'Avery', role: 'Checks', look: { body: 3, color: 3, eyes: 3, mouth: 3, top: 0, detail: 0 } },
  { name: 'Juno', role: 'Writer', look: { body: 0, color: 4, eyes: 4, mouth: 7, top: 2, detail: 1 } },
];
