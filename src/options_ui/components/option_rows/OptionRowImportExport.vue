<script setup lang="ts">
import { objectMap } from '@antfu/utils'
import { useFileDialog } from '@vueuse/core'

import { api, filterWithInvert, saveAs, toast } from '#common'

const EXPORT_VARIANTS = [{
  fileSuffix: '',
  keyPrefix: '',
  title: 'Export all',
  subtitle: 'Recommended for backup',
}, {
  fileSuffix: '_options',
  keyPrefix: 'option.',
  title: 'Export options only',
  subtitle: 'Recommended for sharing with others',
}, {
  fileSuffix: '_cache',
  keyPrefix: 'cache.',
  title: 'Export cache only',
  subtitle: 'Not generally useful/recommended',
}] as const

/**
 * Option keys holding filter lists. On export we add a legacy `invert` flag to
 * each filter mirroring its `behavior`, so the file still force-shows correctly
 * if loaded by the original (upstream) extension, which reads `invert` rather
 * than `behavior`. Importing an upstream file is handled the other way round, by
 * the migrations (see {@link filterFromInvert}).
 */
const FILTER_OPTION_KEYS = ['option.hideTags', 'option.hideAuthors']

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

async function startExport({ keyPrefix, fileSuffix }: typeof EXPORT_VARIANTS[number]): Promise<void> {
  let items = await browser.storage.local.get()
  if (keyPrefix)
    items = objectMap(items, (k, v) => k.startsWith(keyPrefix) ? [k, v] as [any, any] : undefined)
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
    title="Data import/export"
    :subtitle="`Approximately ${sizeUsed}kB bytes used`"
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
            :key="variant.keyPrefix"
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
