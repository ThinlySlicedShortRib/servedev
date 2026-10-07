import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // shadcn-generated primitives export their cva variants and hooks
    // (buttonVariants, useSidebar, useComboboxAnchor, ...) next to the
    // components, the way the registry ships them. Moving those into sibling
    // files would make every `shadcn add --overwrite` or registry diff fight
    // our layout, so this one rule is relaxed for these files only. The cost:
    // editing one of them does a full page reload instead of a fast refresh.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
