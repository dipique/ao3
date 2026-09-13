<script setup lang="ts">
/**
 * Every works list the extension holds a snapshot of, one row each — today the
 * three `SearchSource`s (Marked for Later, a tag's works, a text search).
 * Nothing about the export is specific to any of them.
 */
const { rows, loading } = useSiteExport()
</script>

<template>
  <p v-if="loading" text="sm muted-fg" py-2>
    Looking for stored lists…
  </p>
  <p v-else-if="!rows.length" text="sm muted-fg" py-2>
    No lists yet. Open one on AO3 first — your <strong>Marked for Later</strong> page, or
    the search button on a tag's works or a search-results page — and it will appear here.
  </p>
  <SiteExportRow v-for="row in rows" :key="row.key" :row="row" />
</template>
