import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const testFilePatterns = [
  '**/*.test.{js,cjs,mjs,ts}',
  '**/*.spec.{js,cjs,mjs,ts}',
  '**/tests/**/*.{js,cjs,mjs,ts}',
];

const legacyRequireImportPatterns = [
  'auth/tests/config.test.ts',
  'gateway/tests/configEnv.test.ts',
  'oracle/src/config.test.ts',
  'reconciliation/src/tests/config-address-validation.test.ts',
  'ricardian/tests/config.nonceStore.test.ts',
  'treasury/tests/config.nonceStore.test.ts',
];

const legacyAnyPatterns = [
  'auth/tests/**/*.ts',
  'gateway/tests/**/*.ts',
  'indexer/src/main.ts',
  'oracle/tests/**/*.ts',
  'ricardian/tests/routerAuthScope.test.ts',
  'sdk/tests/**/*.ts',
  'treasury/tests/routerAuthScope.test.ts',
  'contracts/tests/**/*.ts',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/artifacts/**',
      '**/cache/**',
      '**/coverage/**',
      '**/typechain-types/**',
      '**/generated/**',
      '**/.husky/**',
      'reports/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
    languageOptions: {
      ...config.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...config.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'off',
    },
  })),
  {
    files: legacyRequireImportPatterns,
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: legacyAnyPatterns,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: testFilePatterns,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-unused-expressions': 'off',
    },
  },
  eslintConfigPrettier,
];
