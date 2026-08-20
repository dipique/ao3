import type { Rule, RuleTarget } from '#common'

import { api, createLogger, options } from '#common'

let lastMenuInstanceId = 0
let nextMenuInstanceId = 1

const COMMON_MENU_PROPS = {
  contexts: ['link'],
  documentUrlPatterns: ['*://*.archiveofourown.org/*'],
  type: process.env.BROWSER === 'firefox' ? 'checkbox' : 'normal',
} satisfies browser.contextMenus._CreateCreateProperties

const TAG_URL_PATTERNS = ['*://*.archiveofourown.org/tags/*']
const AUTHOR_URL_PATTERNS = ['*://*.archiveofourown.org/users/*', '*://*.archiveofourown.org/users/*/pseuds/*']
const AUTHOR_PSEUD_URL_PATTERNS = ['*://*.archiveofourown.org/users/*/pseuds/*']

const logger = createLogger('BG/menus')

function onCreated() {
  if (browser.runtime.lastError)
    logger.error('Error creating menu item:', browser.runtime.lastError)
}

/**
 * The exact rule a menu item points at: what it targets, the value, and (for a
 * pseud) which pseud. The same shape the in-page menus use — see
 * `content_script/persistentFilters.ts` — kept separate only because the
 * background can't import the content script.
 */
interface RuleKey {
  target: RuleTarget
  value: string
  pseud?: string
  /** How the toast names it, e.g. `tag "Fluff"`. */
  describe: string
}

function ruleMatches(rule: Rule, key: RuleKey): boolean {
  return rule.matcher === 'exact'
    && rule.target === key.target
    && rule.value === key.value
    && (rule.pseud ?? undefined) === (key.pseud ?? undefined)
}

if (browser.contextMenus) {
  // Chrome is stupid and doesn't remove old ones when reloading extension
  void browser.contextMenus.removeAll()

  const menus = {
    tag: {
      hide: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Hide' : 'Hide/unhide'} tag.`,
        TAG_URL_PATTERNS,
      ),
      show: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Show' : 'Show/unshow'} tag (inverts hide).`,
        TAG_URL_PATTERNS,
      ),
    },
    author: {
      hide: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Hide' : 'Hide/unhide'} author.`,
        AUTHOR_URL_PATTERNS,
      ),
      show: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Show' : 'Show/unshow'} author (inverts hide).`,
        AUTHOR_URL_PATTERNS,
      ),
      hidePseud: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Hide' : 'Hide/unhide'} this author pseud.`,
        AUTHOR_PSEUD_URL_PATTERNS,
      ),
      showPseud: createLinkMenuItem(
        `${process.env.BROWSER === 'firefox' ? 'Show' : 'Show/unshow'} this author pseud (inverts hide).`,
        AUTHOR_PSEUD_URL_PATTERNS,
      ),
    },
  }

  /** Every menu item, paired with the rule key it acts on. */
  const PAIRS = [
    {
      hide: menus.tag.hide,
      show: menus.tag.show,
      async key(linkUrl: string, _parts: string[], tabId: number): Promise<RuleKey> {
        const tag = await api.getTag.sendToTab(tabId, linkUrl)
        return { target: tag.type ?? 'tag', value: tag.name, describe: `tag "${tag.name}"` }
      },
    },
    {
      hide: menus.author.hide,
      show: menus.author.show,
      async key(_linkUrl: string, parts: string[]): Promise<RuleKey> {
        return { target: 'author', value: parts[1]!, describe: `author "${parts[1]}"` }
      },
    },
    {
      hide: menus.author.hidePseud,
      show: menus.author.showPseud,
      async key(_linkUrl: string, parts: string[]): Promise<RuleKey> {
        return {
          target: 'author',
          value: parts[1]!,
          pseud: parts[3],
          describe: `pseud "${parts[3]}" of author "${parts[1]}"`,
        }
      },
    },
  ]

  function sendHideToast(tab: browser.tabs.Tab, action: 'hide' | 'show', what: string, alreadyExisted: boolean, wasInverted?: boolean) {
    const actionVerb = action === 'hide'
      ? (alreadyExisted && !wasInverted ? 'unhidden' : 'hidden')
      : (alreadyExisted && wasInverted ? 'unshown' : 'shown')

    void api.toast.sendToTab(tab.id!, `The ${what} has been ${actionVerb}.`, { type: 'success' })
  }

  /**
   * Apply one menu click: find the rule this link already has (if any), drop it,
   * and add the chosen behaviour back unless the click was undoing what was
   * already there. Priority is left off, so the rule takes its behaviour's
   * default — the same thing the in-page menus write.
   */
  async function applyMenuClick(hiding: boolean, key: RuleKey, tab: browser.tabs.Tab) {
    const rules = await options.get('rules')
    const filters = rules.filters
    const index = filters.findIndex(f => ruleMatches(f, key))
    const old = index !== -1 ? filters[index] : undefined
    const wasShown = old ? old.behavior === 'invert' : undefined

    if (old)
      filters.splice(index, 1)

    sendHideToast(tab, hiding ? 'hide' : 'show', key.describe, !!old, wasShown)

    // Clicking the behaviour it already had removes the rule; anything else replaces it.
    if (!old || wasShown === hiding) {
      filters.push({
        target: key.target,
        value: key.value,
        ...(key.pseud !== undefined ? { pseud: key.pseud } : {}),
        matcher: 'exact',
        ...(hiding ? {} : { behavior: 'invert' as const }),
      })
    }

    await options.set({ rules: { ...rules, enabled: true, filters } })
  }

  async function onMenuClick(info: browser.contextMenus.OnClickData, tab: browser.tabs.Tab) {
    if (!info.linkUrl)
      return

    const parts = new URL(info.linkUrl).pathname.split('/').filter(Boolean)

    for (const pair of PAIRS) {
      if (info.menuItemId !== pair.hide && info.menuItemId !== pair.show)
        continue
      const key = await pair.key(info.linkUrl, parts, tab.id!)
      await applyMenuClick(info.menuItemId === pair.hide, key, tab)
    }
  }

  if (process.env.BROWSER === 'firefox') {
    async function onMenuShown(info: browser.contextMenus._OnShownInfo, tab: browser.tabs.Tab) {
      if (!info.linkUrl)
        return

      const parts = new URL(info.linkUrl).pathname.split('/').filter(Boolean)

      const menuInstanceId = nextMenuInstanceId++
      lastMenuInstanceId = menuInstanceId

      for (const pair of PAIRS) {
        if (!info.menuIds.includes(pair.hide!) && !info.menuIds.includes(pair.show!))
          continue
        const key = await pair.key(info.linkUrl, parts, tab.id!)
        const { filters } = await options.get('rules')
        const rule = filters.find(f => ruleMatches(f, key))
        const shown = rule ? rule.behavior === 'invert' : false

        await browser.contextMenus.update(pair.hide!, { checked: !!rule && !shown })
        await browser.contextMenus.update(pair.show!, { checked: !!rule && shown })
      }

      // Abort if the menu got closed
      if (menuInstanceId !== lastMenuInstanceId)
        return

      await browser.contextMenus.refresh()
    }

    browser.contextMenus.onShown.addListener((info, tab) => {
      if (!tab)
        return
      onMenuShown(info, tab).catch(e => logger.error(e))
    })

    browser.contextMenus.onHidden.addListener(() => {
      lastMenuInstanceId = 0
    })
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab)
      return
    onMenuClick(info, tab).catch(e => logger.error(e))
  })
}

function createLinkMenuItem(title: string, urlPatterns: string[]) {
  return browser.contextMenus?.create({
    ...COMMON_MENU_PROPS,
    id: title,
    title,
    targetUrlPatterns: urlPatterns,
  }, onCreated)
}
