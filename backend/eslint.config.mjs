import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // files ESLint should never look at all (global exclusion)
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'] },

  // Eslint's and typescript-eslint's baseline correctness rules
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // CommonJS tool configs (jest.config.js, ...)
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },

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
        { type: 'workers', pattern: 'src/workers/**' },
        { type: 'module', pattern: 'src/modules/*', capture: ['moduleName'] },
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
              allow: [['module', { moduleName: '{{from.moduleName}}' }]],
            },

            // Every module can use identity (auth guard and authorization helpers)
            {
              from: 'module',
              allow: [['module', { moduleName: 'identity' }]],
            },

            // alerts -> incidents, appService
            {
              from: [['module', { moduleName: 'alerts' }]],
              allow: [
                ['module', { moduleName: 'incidents' }],
                ['module', { moduleName: 'appService' }],
              ],
            },

            // Workers are composition code: they may use modules, shared and infra
            {
              from: 'workers',
              allow: ['module', 'shared', 'infra', 'workers'],
            },

            // infra and shared stay free of business modules
            {
              from: 'infra',
              allow: ['shared', 'infra'],
            },
            {
              from: 'shared',
              allow: ['shared'],
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
            // Only a module's index.ts is public
            {
              target: 'module',
              allow: 'index.ts',
            },

            // Everything else is importable file by file
            {
              target: ['shared', 'infra', 'workers'],
              allow: '**',
            },
          ],
        },
      ],
    },
  },

  prettierConfig, // must load last, so it can turn off conflicting rules.
);
