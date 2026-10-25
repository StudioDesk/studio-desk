// Lint rules for the dashboard (Decision MP-026), including React's rules of hooks. Root files like this
// one are protected from stories, so the pipeline cannot loosen its own checks.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/', '.dist-*/', '.vite-cache/']),
  {
    files: ['dashboard/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
]);
