<script setup lang="ts">
import { vLayoutVar } from '../directives/vLayoutVar.ts'
</script>

<template>
  <footer v-layout-var="{ height: '--footer-height' }" class="bg-ao3" flex="~ col gap2" px-4 py-8 text="primary-fg sm">
    <p>
      If you find a bug or have a feature request, please file an issue at the <a class="link" href="https://github.com/dipique/ao3" target="_blank">github repository</a>.
    </p>
  </footer>
</template>
