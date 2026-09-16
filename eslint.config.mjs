import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/migrations/**',
      // The Flutter client is Dart, and `flutter build web` emits a 96,000-line
      // compiled bundle. Neither is this linter's to have an opinion about.
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
)
