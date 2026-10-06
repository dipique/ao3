<script setup lang="ts">
const { total } = useOptionSearch()
const version = browser.runtime.getManifest().version
</script>

<template>
  <footer flex="~ col gap-2" text="[11.5px] muted-fg" leading-normal>
    <p>
      If you find a bug or have a feature request, please file an issue at the <a class="link" href="https://github.com/dipique/ao3" target="_blank">github repository</a>.
    </p>
    <p flex="~ justify-between gap-2">
      <span>{{ total }} settings</span>
      <span>v{{ version }}</span>
    </p>
  </footer>
</template>
