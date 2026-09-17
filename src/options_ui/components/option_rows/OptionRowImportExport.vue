<script setup lang="ts">
import { objectMap } from '@antfu/utils'
import { useFileDialog } from '@vueuse/core'

import { api, BLURB_DATA_PREFIX, BLURB_INDEX_KEY, BLURB_PREFIX, filterWithInvert, saveAs, toast } from '#common'
import { WORK_TEXT_INDEX_KEY, WORK_TEXT_PREFIX } from '#content_script/siteExport/workText.js'

/**
 * Keys no variant exports, whatever else it takes.
 *
 * Cached work text is an order of magnitude larger than everything else in
 * `storage.local` put together, so a file carrying it would be hundreds of
 * megabytes of other people's fic — built here, in the options page, by
 * stringifying the lot. It is also the one thing in storage that can always be
 * fetched again, which is what makes leaving it out safe as well as necessary.
 */
const NEVER_EXPORTED: readonly string[] = [WORK_TEXT_PREFIX, WORK_TEXT_INDEX_KEY]

/**
 * Which storage keys each variant takes, by prefix; an empty list means
 * everything that isn't in {@link NEVER_EXPORTED}. The cache takes the stored
 * blurbs with it: its lists hold only work keys, and a file of lists without the
 * blurbs they name would import as lists of nothing.
 */
const EXPORT_VARIANTS = [{
  fileSuffix: '',
  keyPrefixes: [] as string[],
  title: 'Export all',
  subtitle: 'Recommended for backup',
}, {
  fileSuffix: '_options',
  keyPrefixes: ['option.'],
  title: 'Export options only',
  subtitle: 'Recommended for sharing with others',
}, {
  fileSuffix: '_cache',
  keyPrefixes: ['cache.', BLURB_PREFIX, BLURB_DATA_PREFIX, BLURB_INDEX_KEY],
  title: 'Export cache only',
  subtitle: 'Not generally useful/recommended',
}] as const

/**
 * Option keys holding rule lists. On export we add a legacy `invert` flag to
 * each rule mirroring its `behavior`, so the file still force-shows correctly if
 * loaded by the original (upstream) extension, which reads `invert` rather than
 * `behavior`. Importing an upstream file is handled the other way round, by the
 * migrations (see {@link filterFromInvert}).
 */
const FILTER_OPTION_KEYS = ['option.rules']

function addInvertFlags(items: Record<string, any>): Record<string, any> {
  const out = { ...items }
  for (const key of FILTER_OPTION_KEYS) {
    const opt = out[key]
    if (opt && Array.isArray(opt.filters))
      out[key] = { ...opt, filters: opt.filters.map(filterWithInvert) }
  }
  return out
}

const { open: startImport, onChange: onImportFilesChanged } = useFileDialog({
  accept: 'application/json',
  multiple: false,
})

const sizeUsed = ref('')

onMounted(async () => {
  sizeUsed.value = (new TextEncoder().encode(
    Object.entries(await browser.storage.local.get())
      .map(([key, value]) => key + JSON.stringify(value))
      .join(''),
  ).length / 1024).toFixed(2)
})

onImportFilesChanged((files) => {
  if (!files || files.length === 0) {
    toast('No file selected', { type: 'error' })
    return
  }

  const file = files[0]!
  const reader = new FileReader()
  reader.onload = (e) => {
    const text = e.target!.result! as string
    const obj = JSON.parse(text) as { [key: string]: unknown }
    browser.storage.local.set(obj).then(async () => {
      await api.runMigrations.sendToBackground()
    }).catch((e) => {
      toast('Failed to import data; see console for details', { type: 'error' })
      console.error(e)
    })
  }
  reader.readAsText(file)
})

/** Whether a storage key belongs in a file this variant writes. */
function exported(key: string, keyPrefixes: readonly string[]): boolean {
  if (NEVER_EXPORTED.some(prefix => key.startsWith(prefix)))
    return false
  return keyPrefixes.length === 0 || keyPrefixes.some(prefix => key.startsWith(prefix))
}

/**
 * The chosen keys and their values.
 *
 * Named first and read second where the browser can list keys without values,
 * so the work text is never brought into this page at all. Where it can't
 * (Firefox before 131), everything is read and then filtered, which is what this
 * always did.
 */
async function readExported(keyPrefixes: readonly string[]): Promise<Record<string, unknown>> {
  const local = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> }
  if (typeof local.getKeys === 'function') {
    const keys = (await local.getKeys()).filter(key => exported(key, keyPrefixes))
    return keys.length ? await local.get(keys) : {}
  }
  const all = await local.get()
  return objectMap(all, (k, v) => exported(k, keyPrefixes) ? [k, v] as [any, any] : undefined)
}

async function startExport({ keyPrefixes, fileSuffix }: typeof EXPORT_VARIANTS[number]): Promise<void> {
  let items = await readExported(keyPrefixes)
  items = addInvertFlags(items)
  const now = new Date()
  const time = `${now.toISOString().slice(0, 10)}_${now.toISOString().slice(11, 19).replace(/:/g, '-')}`
  const name = `AO3-Enhancements${fileSuffix}_${time}.json`
  const blob = new Blob([JSON.stringify(items, null, 2)], {
    type: 'application/json',
  })
  saveAs(blob, name)
}
</script>

<template>
  <OptionRow
    title="Import &amp; export your settings"
    :subtitle="`Save every setting, rule and mark to a file, or load one back in. ~${sizeUsed}kB in use.`"
  >
    <div flex="~ row items-center gap-3">
      <Button variant="outline" @click.prevent="startImport">
        Import
      </Button>
      <DropdownMenu :modal="false">
        <DropdownMenuTrigger>
          <Button variant="outline">
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            v-for="variant in EXPORT_VARIANTS"
            :key="variant.fileSuffix"
            flex="~ col items-start gap-1"
            px-4 py-3
            @click="() => startExport(variant)"
          >
            <span text-sm font-medium leading-none>{{ variant.title }}</span>
            <span line-clamp-2 text-sm text-muted-fg leading-snug>{{ variant.subtitle }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </OptionRow>
</template>
