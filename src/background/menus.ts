import type { RuleKey } from '#common'

import { api, authorKey, createLogger, options, tagKey } from '#common'

import type { MenuChoice } from './menuRules.ts'

import { menuChecks, menuClick, menuVerb } from './menuRules.ts'

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

/** The exact rule a menu item points at, and how the toast names it. */
interface MenuRuleKey extends RuleKey {
  /** E.g. `tag "Fluff"`. */
  describe: string
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
      async key(linkUrl: string, _parts: string[], tabId: number): Promise<MenuRuleKey> {
        const tag = await api.getTag.sendToTab(tabId, linkUrl)
        return { ...tagKey(tag), describe: `tag "${tag.name}"` }
      },
    },
    {
      hide: menus.author.hide,
      show: menus.author.show,
      async key(_linkUrl: string, parts: string[]): Promise<MenuRuleKey> {
        return { ...authorKey(parts[1]!), describe: `author "${parts[1]}"` }
      },
    },
    {
      hide: menus.author.hidePseud,
      show: menus.author.showPseud,
      async key(_linkUrl: string, parts: string[]): Promise<MenuRuleKey> {
        return { ...authorKey(parts[1]!, parts[3]), describe: `pseud "${parts[3]}" of author "${parts[1]}"` }
      },
    },
  ]

  async function applyMenuClick(choice: MenuChoice, key: MenuRuleKey, tab: browser.tabs.Tab) {
    const rules = await options.get('rules')
    const { filters, undone } = menuClick(rules.filters, key, choice, rules)
    void api.toast.sendToTab(tab.id!, `The ${key.describe} has been ${menuVerb(choice, undone)}.`, { type: 'success' })
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
      await applyMenuClick(info.menuItemId === pair.hide ? 'hide' : 'show', key, tab)
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
        const checks = menuChecks((await options.get('rules')).filters, key)
        await browser.contextMenus.update(pair.hide!, { checked: checks.hide })
        await browser.contextMenus.update(pair.show!, { checked: checks.show })
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
