/** The canonical fandom AO3 files works with no source fandom under. */
export const ORIGINAL_WORK = 'Original Work'

/**
 * Whether a fandom resolved to `id` is one AO3 merged into Original Work rather
 * than Original Work itself.
 *
 * A synonym's tag page redirects to its canonical, so the id learned for it is
 * the canonical's — which for most synonyms is the same fandom under another
 * spelling, and filtering by it is what the reader means. Original Work is the
 * exception: subreddits, podcasts and other sources that aren't fandoms are
 * merged into it wholesale, and excluding its id to drop one of them would drop
 * every original work with it. Such a fandom has to be filtered by its own name,
 * which AO3 resolves to the tag itself and matches only on works carrying it.
 *
 * Import-free, so it loads under a plain `node --test`.
 */
export function mergedIntoOriginalWork(name: string, id: number | null, originalWorkId: number | null): boolean {
  return id != null
    && id === originalWorkId
    && name.trim().toLowerCase() !== ORIGINAL_WORK.toLowerCase()
}
