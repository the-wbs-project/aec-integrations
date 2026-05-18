import tseslint from 'typescript-eslint';
import { ignores, tsBase, prettierCompat } from '../../eslint.config.base.mjs';

export default tseslint.config(ignores, ...tsBase, prettierCompat);
