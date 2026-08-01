import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '../pb_public/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'family-chart',
              message: 'Use src/adapters/family-chart-adapter.js instead.',
            },
          ],
          patterns: [
            {
              group: ['family-chart/*'],
              message: 'Use src/adapters/family-chart-adapter.js instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/adapters/family-chart-adapter.js'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['tests/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
