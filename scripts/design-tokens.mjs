// Development tool: writes the dashboard's tokens.css from the Studio desk design system's tokens.json
// (https://claude.ai/artifact/Q5thTN2HHnbZG5esebUGbZ, project/tokens.json). Dark is the default theme; light applies
// when the director chooses it in Settings, or follows the system and the system is light.
// Usage: node scripts/design-tokens.mjs <tokens.json> [dashboard/src/design/tokens.css]
import fs from 'node:fs';

const [source, out = 'dashboard/src/design/tokens.css'] = process.argv.slice(2);
if (!source) throw new Error('Usage: node scripts/design-tokens.mjs <tokens.json> [out.css]');
const tokens = JSON.parse(fs.readFileSync(source, 'utf8'));
const [dark, light] = tokens.color.themes.map(theme => theme.id);
const value = (token, theme) => {
  const v = typeof token.value === 'string' ? token.value : (token.value[theme] ?? token.value[dark]);
  return /^\{.+\}$/.test(v) ? `var(--${v.slice(1, -1)})` : v;
};
const themed = (theme, indent = '  ') =>
  [...tokens.color.tokens, ...tokens.shadow.tokens].map(token => `${indent}--${token.name}: ${value(token, theme)};`);
const plain = [...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.size.tokens].map(
  token => `  --${token.name}: ${token.value};`,
);
const fonts = Object.entries(tokens.type.families).map(([name, stack]) => `  --font-${name}: ${stack};`);

fs.writeFileSync(
  out,
  `/* Generated from the Studio desk design system's tokens.json (https://claude.ai/artifact/Q5thTN2HHnbZG5esebUGbZ)
   by scripts/design-tokens.mjs. Change a token in the design system, then generate this file again; don't edit it
   by hand. Dark is the default theme; light applies when the director chooses it in Settings, or follows the system
   and the system is light. */
:root {
  color-scheme: dark;
${[...themed(dark), ...plain, ...fonts].join('\n')}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme='${dark}']) {
    color-scheme: light;
${themed(light, '    ').join('\n')}
  }
}
:root[data-theme='${light}'] {
  color-scheme: light;
${themed(light).join('\n')}
}
`,
);
console.log(`Wrote ${out}. Run npm run format before committing.`);
