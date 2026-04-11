import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const sharedCodeQualityRules = {
  eqeqeq: ['error', 'always'],
  curly: ['error', 'all'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-implicit-coercion': 'error',
  'no-useless-return': 'error',
  'no-useless-concat': 'error',
  'no-extra-boolean-cast': 'error',
  'object-shorthand': ['error', 'always'],
};

const testFilePatterns = [
  '**/*.test.{js,cjs,mjs,ts}',
  '**/*.spec.{js,cjs,mjs,ts}',
  '**/tests/**/*.{js,cjs,mjs,ts}',
];

const typeAwareRuntimePatterns = [
  'auth/src/**/*.ts',
  'gateway/src/**/*.ts',
  'indexer/src/**/*.ts',
  'oracle/src/**/*.ts',
  'sdk/src/**/*.ts',
  'reconciliation/src/**/*.ts',
  'notifications/src/**/*.ts',
  'ricardian/src/**/*.ts',
  'treasury/src/**/*.ts',
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
    rules: {
      ...js.configs.recommended.rules,
      ...sharedCodeQualityRules,
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
    rules: sharedCodeQualityRules,
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
      ...sharedCodeQualityRules,
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
    files: typeAwareRuntimePatterns,
    ignores: testFilePatterns,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
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
