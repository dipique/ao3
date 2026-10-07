<script lang="ts" setup>
import Advanced from './Advanced.vue'
import Lists from './Lists.vue'
import Reading from './Reading.vue'
import Search from './Search.vue'
import SiteFeatures from './SiteFeatures.vue'
import SyncBackups from './SyncBackups.vue'

const { query, searching, matchCount, total } = useOptionSearch()
</script>

<template>
  <div flex="~ col">
    <p v-if="searching" text="xs muted-fg" pb-4>
      {{ matchCount }} of {{ total }} settings match.
    </p>

    <p v-if="searching && matchCount === 0" text="sm muted-fg" py-8 text-center>
      Nothing matches “{{ query }}”. Try a word from the setting's description.
    </p>

    <!-- Rendered in rail order: the rail lists the categories in the order they register. -->
    <SiteFeatures />
    <Search />
    <Lists />
    <Reading />
    <SyncBackups />
    <Advanced />
  </div>
</template>
