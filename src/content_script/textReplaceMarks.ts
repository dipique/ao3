import { ADDON_CLASS } from '#common'

/**
 * How a replaced run of a work's text is marked up, in its own leaf module so
 * the unit that writes the marks ({@link file://./units/TextReplace.ts}) and the
 * one that reads them ({@link file://./units/TextReplaceTools.tsx}) can share
 * them without importing each other.
 *
 * Note what is *not* here: `ADDON_CLASS`. Every `.AO3E` element is removed
 * outright by the page-wide clean-up before a re-run, and these spans hold the
 * work's own words — `TextReplace.clean` unwraps them itself instead.
 */

/** Wraps one run of text a rule replaced. */
export const REPLACED_CLASS = `${ADDON_CLASS}--replaced`

/** On that span: the index of the rule that wrote it, in `options.textReplacements.rules`. */
export const REPLACED_RULE_ATTR = 'data-ao3e-replaced-by'
