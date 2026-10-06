import { kebabCase } from 'change-case'

/**
 * Anchor id for a sub-section or a row, and the normalisation a `#hash` is put
 * through before it is looked up. Deliberately not `kebabCase`, which splits on
 * case boundaries and turns "Compress filter URLs" into `compress-filter-ur-ls`.
 */
export function anchorSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** A category's anchor id, from its title. */
export function categoryId(title: string): string {
  return kebabCase(title)
}
