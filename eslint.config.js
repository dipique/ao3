import antfu from '@antfu/eslint-config'

export default antfu({
  // Generated, megabytes of it, and not ours to format: linting it produced
  // ~47,000 of the ~47,100 problems this config used to report, which made the
  // gate unreadable and so unused. See `scripts/generate-fandom-index.mjs`.
  ignores: [
    'src/data/**',
  ],
  stylistic: true,
  unocss: {
    overrides: {
      'unocss/order': 'error',
      'unocss/order-attributify': 'error',
    },
  },
  typescript: {
    tsConfigPath: './tsconfig.json',
  },
  vue: {
    overrides: {
      'vue/block-order': ['error', {
        order: ['script', 'template', 'style'],
      }],
      'vue/singleline-html-element-content-newline': ['error', {
        externalIgnores: ['ArchiveLink'],
      }],
    },
  },
  rules: {
    'no-console': 'off',
    'antfu/top-level-function': 'off',
    'node/prefer-global/process': 'off',
    // The suite is Node's own runner, deliberately (see the README): there is no
    // vitest here for this rule to send us to.
    'test/no-import-node-test': 'off',
    // Opinions about how pnpm installs and runs scripts, not about this code.
    // `--fix` would write them into pnpm-workspace.yaml, and `shellEmulator`
    // in particular changes how every script runs on Windows; that is a decision
    // to make deliberately, not one to inherit from a lint pass.
    'pnpm/yaml-enforce-settings': 'off',
    'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
    'perfectionist/sort-imports': ['error', {
      groups: [
        'type-import',
        ['builtin', 'external'],
        'icons',
        'type-internal',
        'internal',
        ['type-parent', 'type-sibling', 'type-index'],
        ['parent', 'sibling', 'index'],
        'side-effect',
        'unknown',
      ],
      newlinesBetween: 1,
      order: 'asc',
      type: 'natural',
      internalPattern: ['^#.+'],
      customGroups: [
        { groupName: 'icons', elementNamePattern: '~icons/.+' },
      ],
    }],
  },
  formatters: {
    css: true,
    html: true,
  },
})
