import js from '@eslint/js';
import tseslint, { plugin } from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // files ESLint should never look at all (global exclusion)
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  // Eslint's and typescript-eslint's baseline correctness rules
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true, // enables type-aware linting
        tsconfigRootDir: import.meta.dirname,
      },
    },

    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
      'boundaries/elements': [
        // IMS's architecture declaration
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'infra', pattern: 'src/infra/**' },
        { type: 'module', pattern: 'src/module/*/**', capture: ['moduleName'] },
      ],
    },
    rules: {
      // Boundaries/element-types and boundaries/entry-point

      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',

          rules: [
            // Every module can use shared + infra
            {
              from: 'module',
              allow: ['shared', 'infra'],
            },

            // A module can use itself
            {
              from: 'module',
              allow: [['module', { moduleName: `${from.moduleName}` }]],
            },

            // alert -> incident, app-service
            {
              from: [['module', { moduleName: 'alert' }]],
              allow: [
                ['module', { moduleName: 'incident' }],
                ['module', { moduleName: 'app-service' }],
              ],
            },
          ],
        },
      ],

      // Other modules must be entered through index.ts
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',

          rules: [
            {
              target: 'module',
              allow: 'index.ts',
            },
          ],
        },
      ],
    },
  },

  prettierConfig, // must load last, so it can turn off conflicting rules.
);
