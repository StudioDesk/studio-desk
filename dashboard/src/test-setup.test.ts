/// <reference types="vite/client" />
// The tests' setup loads every page the dashboard loads on demand (test-setup.ts). A page added later with lazyPage
// or React's lazy must join its list, or its tests would wait on its code again. The setup also sets how long every
// find waits, so a test that names no wait of its own still waits long enough on a busy computer.
import { getConfig, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { onDemandPages } from './router';
import { findWait, onDemandModules, testLimit } from './test-setup';

const sources = Object.values(
  import.meta.glob<string>(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

test('every page the router loads on demand is loaded before each test file', () => {
  const declared = sources.join('\n').match(/\blazyPage\(\(\) => import\(/g) ?? [];
  expect(declared.length).toBeGreaterThan(0);
  expect(onDemandPages).toHaveLength(declared.length);
  for (const page of onDemandPages) expect(typeof page.preload).toBe('function');
});

test("every component loaded with React's lazy is loaded before each test file", () => {
  const imported = new Set<string>();
  for (const source of sources)
    for (const match of source.matchAll(/\blazy\(\(\) => import\('(\.\/[\w-]+)'\)/g))
      if (match[1]) imported.add(match[1]);
  expect([...imported].sort()).toEqual(Object.keys(onDemandModules).sort());
});

afterEach(() => document.body.replaceChildren());

test('every find waits as long as the setup says, not the testing library’s one second', () => {
  expect(findWait).toBeGreaterThan(1000);
  expect(getConfig().asyncUtilTimeout).toBe(findWait);
  expect(testLimit).toBeGreaterThan(findWait);
});

test('a find that names no wait still finds a button that appears after more than one second', async () => {
  setTimeout(() => {
    const button = document.createElement('button');
    button.textContent = 'Late';
    document.body.append(button);
  }, 1500);
  expect(await screen.findByRole('button', { name: 'Late' })).toBeTruthy();
});
