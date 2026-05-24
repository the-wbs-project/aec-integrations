import tseslint from 'typescript-eslint';
import globals from 'globals';
import { ignores, tsBase, angularBase, prettierCompat } from '../../eslint.config.base.mjs';

export default tseslint.config(
  ignores,
  ...tsBase,
  ...angularBase,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: ['app', 'aec'], style: 'kebab-case' },
      ],
    },
  },
  prettierCompat,
);
