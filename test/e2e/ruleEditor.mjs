import assert from 'node:assert/strict'

/**
 * The rules list and its editor, driven as the rules' e2e tests drive them.
 * Not a test file itself. Each control is found by what it does
 * (`data-action`), the field it edits (`data-rule-field`) or, for a choice,
 * the value choosing it stores: never by its words.
 */

/** The rules list's `data-list`. */
export const RULES_LIST = 'rules'

export class RuleEditor {
  /** `options`: the {@link OptionsPage} the rules list is on. */
  constructor(options) {
    this.options = options
  }

  get page() {
    return this.options.page
  }

  /** The open editor: the dialog holding the rule's fields, under any dialog opened over it. */
  dialog() {
    return this.page.waitForSelector('[role="dialog"]:has([data-rule-field])', { timeout: 5000 })
  }

  /** Whether a rule editor is open. */
  isOpen() {
    return this.page.evaluate(() => !!document.querySelector('[role="dialog"] [data-rule-field]'))
  }

  /** The list's Add, in its header. */
  async addButton() {
    return this.options.action(await this.options.list(RULES_LIST), 'add')
  }

  /** Open a blank editor from Add, and say whether the editor opened. */
  async openAdd() {
    await this.options.openDialog(await this.addButton())
    return this.isOpen()
  }

  /** The row of the stored rule matching `value`: a row is the rule at that place in the stored list. */
  async row(value) {
    const { filters } = await this.options.stored('option.rules')
    const at = filters.findIndex(rule => rule.value === value)
    assert.notEqual(at, -1, `no stored rule ${JSON.stringify(value)}`)
    return this.options.listRow(RULES_LIST, at)
  }

  /** Open the editor on the stored rule matching `value`, from its row's Edit, and say whether it opened. */
  async openEdit(value) {
    await this.options.openDialog(await this.options.action(await this.row(value), 'edit'))
    return this.isOpen()
  }

  /** The control editing `field`: `value`, `test` or `enabled`, or a group of choices. */
  async field(name) {
    const handle = await (await this.dialog()).$(`[data-rule-field="${name}"]`)
    assert.ok(handle, `no rule field ${name}`)
    return handle
  }

  /** Every choice of a group: `target`, `matcher`, `action` or `swatch`. */
  async choices(field) {
    return (await this.field(field)).$$('[role="radio"]')
  }

  /** The choice of a group that stores `value`. */
  async choice(field, value) {
    const handle = await (await this.field(field)).$(`[role="radio"][value="${value}"]`)
    assert.ok(handle, `no ${field} choice ${value}`)
    return handle
  }

  /** Choose it, and wait until it is the one chosen. */
  async pick(field, value) {
    const chosen = await this.choice(field, value)
    await this.options.press(chosen)
    await this.page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', {}, chosen)
  }

  /** Replace the text of a field, `value` or `test`, by typing. */
  async retype(name, text) {
    const field = await this.field(name)
    await field.evaluate(el => el.select())
    await field.type(text)
  }

  /** Save, or Add rule while adding: one button, which stores the rule. */
  async saveButton() {
    return this.options.action(await this.dialog(), 'save')
  }

  /** Press Save, and wait until the editor has closed and the rules are written. */
  async save() {
    await this.options.press(await this.saveButton())
    await this.page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await this.options.saved()
  }

  /** The stored rule matching `value`, as last written. */
  async written(value) {
    return (await this.options.lastWrite('option.rules'))?.filters?.find(rule => rule.value === value)
  }
}
