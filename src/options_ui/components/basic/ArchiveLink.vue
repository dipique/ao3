<script setup lang="ts">
import { getArchiveLink } from '#common'

const props = defineProps<{
  userPath?: string
  path?: string
  /** An address that is already whole — a stored one, say, rather than a path to build. */
  href?: string
}>()

const { userId } = useOption('user')

const resolved = computed(() => {
  if (props.href)
    return props.href
  if (props.userPath)
    return userId?.value ? getArchiveLink(`/users/${userId.value}${props.userPath}`) : undefined
  if (props.path)
    return getArchiveLink(props.path)
  return undefined
})
</script>

<template>
  <a
    :href="resolved"
    target="_blank"
    rel="noopener noreferrer"
    :class="{ link: !!resolved }"
  >
    <slot />
  </a>
</template>
