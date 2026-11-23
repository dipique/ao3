<script setup lang="ts">
const enabled = useOption('markForLaterToolbar')
const button = useOption('markForLaterButton')
</script>

<template>
  <!-- Not gated by Right-click menus: with menus off it still drives the mark
       buttons on a work and the entity toolbars. -->
  <OptionRowCollapsable
    v-model:open="enabled"
    anchor="mark-for-later-toolbar"
    :options="['markForLaterToolbar', 'markForLaterButton']"
    title="Mark a work for later"
    subtitle="Adds “Mark for later” and “Mark as read” to a work's menu, so you can update your Marked for Later list without opening the work. Your Marked for Later list's own search view has them either way."
    :badges="['needs-login']"
  >
    <!-- Laid out as a setting but not an `OptionRow`, so the settings search
         doesn't enter it as a row of its own apart from this one. -->
    <label
      for="ao3e-mark-for-later-button"
      grid="~ cols-[1fr_min-content] items-center"
      cursor-pointer py-1
    >
      <div flex="~ col" mr-4>
        <span text="[13.5px]" leading="[18px]">Button beside titles</span>
        <span text="[12px] muted-fg" leading="[17px]">
          An outlined clock beside each work you haven't read or saved. One click or tap adds it to Marked for Later.
        </span>
      </div>
      <Switch id="ao3e-mark-for-later-button" v-model="button" data-action="mark-for-later-button" />
    </label>
  </OptionRowCollapsable>
</template>
