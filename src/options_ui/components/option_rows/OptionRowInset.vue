<script setup lang="ts">
/*
  What a settings row reveals, or keeps under its line, recessed into a panel
  across the whole row: for the row's `extra` slot. The space above the panel
  is padding rather than a margin, so an open/close animation, which clips,
  carries it too.
*/
</script>

<template>
  <div pb-1 pt-2>
    <div
      data-row-inset
      bg-sunken border="1 solid hair" rounded="[10px]" p="2.5 md:3.5"
    >
      <slot />
    </div>
  </div>
</template>
