import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { KindTile } from './kind-tile';

afterEach(cleanup);

test('the library tile shows its kind and tone and is hidden from assistive technology', () => {
  render(<KindTile path="docs/Brand.MARKDOWN" />);
  const tile = screen.getByText('MD');
  expect(tile.classList.contains('sd-kindtile')).toBe(true);
  expect(tile.classList.contains('sd-kindtile--documents')).toBe(true);
  expect(tile.classList.contains('sd-kindtile--sm')).toBe(false);
  expect(tile.getAttribute('aria-hidden')).toBe('true');
});

test.each([
  ['pictures/shop.JPEG', 'JPG', 'pictures'],
  ['docs/reference.pdf', 'PDF', 'pdfs'],
  ['data/prices.csv', 'CSV', 'data'],
  ['src/main.ts', 'TS', 'code'],
  ['NOTES', 'FILE', 'other'],
])('the small work tile for %s shows %s with the %s tone', (path, label, tone) => {
  render(<KindTile path={path} small />);
  const tile = screen.getByText(label);
  expect(tile.classList.contains('sd-kindtile')).toBe(true);
  expect(tile.classList.contains('sd-kindtile--sm')).toBe(true);
  expect(tile.classList.contains(`sd-kindtile--${tone}`)).toBe(true);
  expect(tile.getAttribute('aria-hidden')).toBe('true');
});
