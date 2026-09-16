import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/migrations/**',
      // Packed plugin bundles. Generated output, not source.
      '**/.pack/**',
    ],
  },
  js.configs.recommended,
  {
    // The build and registry scripts are Node programs, not application code:
    // they read argv, print progress and exit with a status. Everything else
    // in here runs in a bundler or a test runner and should not touch either.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', globalThis: 'readonly' },
    },
  },
  tseslint.configs.recommended,
)
