import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import process from 'node:process'
import { parse } from 'semver'
import webExt from 'web-ext'

import pJson from '../package.json' with { type: 'json' }
import chromeConfig from './web-ext.chrome.mjs'
import firefoxConfig from './web-ext.firefox.mjs'

// Neither of the two external commands below goes through a shell, deliberately.
// Shelling out used to mean zx, which picks its shell by finding `bash` on PATH —
// and on Windows that is whichever `bash` the calling shell put there first. From
// PowerShell it is system32's WSL launcher, so the whole packaging step ran as a
// Linux process, with WSL's Node and WSL's git, against the tree through WSL's
// mount of the drive; from a Git Bash prompt the same command ran natively. Which
// platform builds the store packages should not be decided by PATH order, so
// web-ext is driven through its Node API and git through `spawn` with no shell.
const configs = {
  chrome: chromeConfig,
  firefox: firefoxConfig,
}

const parsed = parse(pJson.version)

if (!parsed) {
  console.error(`Invalid version in package.json`)
  process.exit(1)
}

const { version } = parsed

await webExtDist('firefox')
await webExtDist('chrome')
await gitArchive()

async function webExtDist(browser: keyof typeof configs) {
  const { artifactsDir, build, ignoreFiles, sourceDir } = configs[browser]
  // The release workflow looks each store package up by name, so have web-ext
  // write the final name itself rather than renaming afterwards — that is also
  // what retires the old parse of "Your web extension is ready: <path>", whose
  // separators used to depend on the platform the shell had chosen.
  const filename = `ao3-enhancements_${browser}_${version}.zip`
  const { extensionPath } = await webExt.cmd.build({
    artifactsDir,
    ignoreFiles,
    sourceDir,
    ...build,
    filename,
  })
  // web-ext puts `filename` through a sanitiser of its own before using it.
  // Ours passes through untouched, but the name is a contract with the release
  // workflow: if that ever stops being true, say so rather than shipping a
  // package the workflow cannot find.
  if (basename(extensionPath) !== filename) {
    console.error(`Expected web-ext to write ${filename}, got ${basename(extensionPath)}`)
    process.exit(1)
  }
}

async function gitArchive() {
  await mkdir('dist/artifacts/source', { recursive: true })
  const output = `dist/artifacts/source/ao3-enhancements_source_${version}.zip`
  await git(['archive', '--format=zip', `--output=${output}`, 'HEAD'])
  console.log(`Your source archive is ready: ${output}`)
}

function git(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    // No shell: `git` is a real executable, which Windows finds on PATH via
    // PATHEXT without one.
    const child = spawn('git', args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0)
        resolve()
      else
        reject(new Error(`git ${args.join(' ')} failed (${signal ?? `exit code ${code}`})`))
    })
  })
}
