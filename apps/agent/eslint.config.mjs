import tseslint from 'typescript-eslint';
import globals from 'globals';
import { ignores, tsBase, prettierCompat } from '../../eslint.config.base.mjs';

export default tseslint.config(
  ignores,
  { ignores: ['.flue-vite/', '.flue-vite.wrangler.jsonc'] },
  ...tsBase,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
      },
    },
  },
  prettierCompat,
);
