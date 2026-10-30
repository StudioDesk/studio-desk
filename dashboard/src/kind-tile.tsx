import { kindLabel, kindTone } from './artifacts';

// Decorative file kind beside the readable name: library cards use the default size, work rows use small.
export function KindTile({ path, small = false }: { path: string; small?: boolean }) {
  return (
    <span className={`sd-kindtile sd-kindtile--${kindTone(path)}${small ? ' sd-kindtile--sm' : ''}`} aria-hidden="true">
      {kindLabel(path)}
    </span>
  );
}
