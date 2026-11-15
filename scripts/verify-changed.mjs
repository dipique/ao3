#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createGraph, nodeFs } from './verify-changed/graph.mjs'
import { planVerify, scopedCommand, tierOf, TIERS } from './verify-changed/plan.mjs'

/**
 * `verify`, cut down to what a change can affect: the typecheck, the generated
 * types check, eslint over the changed files, and the tests whose imports reach
 * a changed file. Falls back to the whole of `verify` when the change touches
 * something no import graph can follow.
 *
 *   node scripts/verify-changed.mjs [--visual] [--base <ref>] [--list]
 *
 * --visual   also run the visual tests the change reaches (as verify:full does)
 * --base     what to compare against (default: where HEAD left main)
 * --list     print the plan and stop
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const visual = args.includes('--visual')
const listOnly = args.includes('--list')
const baseAt = args.indexOf('--base')
const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean)
}

function exitOnFailure(label, { status }) {
  if (status !== 0) {
    console.error(`\n${label} failed`)
    process.exit(status ?? 1)
  }
}

function run(label, command, commandArgs) {
  console.log(`\n> ${label}`)
  exitOnFailure(label, spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' }))
}

/** pnpm through a shell, which is how Windows finds `pnpm.cmd`. */
function pnpm(label, ...pnpmArgs) {
  console.log(`\n> ${label}`)
  const command = ['pnpm', ...pnpmArgs.map(arg => JSON.stringify(arg))].join(' ')
  exitOnFailure(label, spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true }))
}

if (!existsSync(join(ROOT, 'node_modules', '.modules.yaml')))
  pnpm('install', 'install', '--frozen-lockfile')

const base = baseAt === -1 ? git('merge-base', 'HEAD', 'main')[0] : args[baseAt + 1]
const deleted = git('diff', '--name-only', '--no-renames', '--diff-filter=D', base)
const changed = [
  ...git('diff', '--name-only', '--no-renames', '--diff-filter=d', base),
  ...git('ls-files', '--others', '--exclude-standard'),
]

const graph = createGraph(nodeFs(ROOT))
const tests = TIERS.flatMap(tier => globSync(tier.glob, { cwd: ROOT }))
  .map(file => file.replaceAll('\\', '/'))
  .map(file => ({ file, tier: tierOf(file), deps: graph.dependencies(file) }))
const plan = planVerify({ changed, deleted, tests, visual })

console.log(`${changed.length} changed and ${deleted.length} deleted since ${base.slice(0, 10)}`)
if (plan.full) {
  console.log('Running all of verify, because:')
  plan.reasons.forEach(reason => console.log(`  - ${reason}`))
}
else {
  for (const tier of TIERS) {
    if (tier.name !== 'visual' || visual)
      console.log(`  ${tier.name}: ${plan[tier.name].length} of ${tests.filter(t => t.tier === tier.name).length} files`)
  }
}
if (listOnly) {
  if (!plan.full)
    TIERS.forEach(tier => plan[tier.name].forEach(file => console.log(`    ${file}`)))
  process.exit(0)
}

if (plan.full) {
  pnpm(visual ? 'verify:full' : 'verify', 'run', visual ? 'verify:full' : 'verify')
  process.exit(0)
}

pnpm('typecheck', 'run', 'typecheck')
pnpm('lint:types', 'run', 'lint:types')
if (plan.lint.length)
  pnpm('eslint (changed files)', 'exec', 'eslint', '--no-warn-ignored', ...plan.lint)
for (const tier of TIERS) {
  if (plan[tier.name].length) {
    const [command, ...nodeArgs] = scopedCommand(scripts[tier.script], tier.glob, plan[tier.name])
    if (command !== 'node')
      throw new Error(`${tier.script} no longer starts with node: "${scripts[tier.script]}"`)
    run(`${tier.script} (${plan[tier.name].length} files)`, process.execPath, nodeArgs)
  }
}
