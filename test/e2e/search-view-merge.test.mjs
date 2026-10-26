import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'
import { installMock } from './helpers.mjs'
import { blurbHtml } from './trackedReview.mjs'

/**
 * Adding works to a view that holds its page layout, and taking others out,
 * while the reader is part-way through it (`SearchView.merge`): the view
 * module on its own, in a real DOM, over works parsed from archive markup.
 *
 * Twelve works, three to a page, the reader on the third page with a search
 * typed and a work-text search applied. Where a merged work lands is decided
 * by the engine (its own unit test has every case); what is pinned down here
 * is that the view draws what it decides and leaves everything else the reader
 * set where it was.
 */
describe('search view: merging works in place', { skip: skipWithoutChrome }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('test/e2e/searchViewEntry.ts', 'SV', { prepare: blank => blank.evaluate(installMock, {}) }))
    await page.evaluate(() => {
      const base = document.createElement('base')
      base.href = 'https://archiveofourown.org/'
      document.head.append(base)
    })
  }, { timeout: 120000 })

  after(async () => close?.())

  const work = (id, order) => ({ html: blurbHtml({ id: String(id), dateText: '01 Oct 2026' }), order })

  /**
   * Open a view over works 1–12 on page 3, then take the steps — a merge
   * (`added`, `gone`), a `remove`, or a `rebuild` from the view's own state
   * and works, as a re-run does — and say what it shows after each.
   */
  const run = merges => page.evaluate(async (input) => {
    const parse = ({ html, order }) => {
      const template = document.createElement('template')
      template.innerHTML = html
      const work = window.SV.parseWork(document.adoptNode(template.content.firstElementChild), order)
      work.markedOrder = order
      return work
    }
    window.__searched = []
    const textSearch = {
      has: () => true,
      search: async (ids) => {
        window.__searched.push([...ids])
        return { hits: new Set(ids), searched: ids.length, unavailable: 0 }
      },
      snippet: async () => null,
    }
    const filter = window.SV.emptyFilterState()
    filter.text = 'Work'
    const config = {
      perPage: 3,
      stablePages: true,
      defaultStatus: [],
      goneReason: 'Moved to a later review',
      // Drawn the way the extension draws what it adds, so a blurb taken back
      // to its stored markup loses it.
      collapseWork: (el, reason) => {
        const note = document.createElement('span')
        note.className = 'AO3E AO3E--test-collapsed'
        note.textContent = reason
        el.append(note)
      },
      textSearch,
      initialState: {
        filter,
        pageIndex: 2,
        facetQueries: {},
        collapsedFacets: [],
        releasedAutoExcludes: [],
        openSelections: {},
        workText: { query: 'dragon', hits: input.works.map((_, i) => String(i + 1)) },
      },
    }
    let view = window.SV.createSearchView(input.works.map(parse), {}, config)
    document.body.replaceChildren(view.el)
    // The work-text search the view opens with runs again behind it; let it land.
    await new Promise(resolve => setTimeout(resolve))
    const shown = () => [...view.el.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => ({ id: li.id.replace('work_', ''), collapsed: li.querySelector('.AO3E--test-collapsed')?.textContent ?? null }))
    const snapshots = [shown()]
    for (const merge of input.merges) {
      window.__searched = []
      if (merge.rebuild) {
        const state = view.getState()
        const held = view.getWorks()
        for (const work of held)
          work.el.querySelector('.AO3E--test-collapsed')?.remove()
        view = window.SV.createSearchView(held, {}, { ...config, initialState: state })
        document.body.replaceChildren(view.el)
        await new Promise(resolve => setTimeout(resolve))
      }
      else if (merge.remove) {
        view.remove(merge.remove)
      }
      else {
        view.merge(merge.added.map(parse), new Set(merge.gone))
      }
      await new Promise(resolve => setTimeout(resolve))
      const state = view.getState()
      snapshots.push({ shown: shown(), order: state.order, page: state.pageIndex, text: state.filter.text, workText: state.workText?.query ?? null, searched: window.__searched.flat() })
    }
    return snapshots
  }, { works: Array.from({ length: 12 }, (_, i) => work(i + 1, i + 1)), merges })

  test('works land where the engine puts them, a gone work collapses in its slot, and nothing the reader set moves', async () => {
    const [opened, added, removed] = await run([
      // 100 sorts between works 1 and 2, on a page already read; 200 between 7
      // and 8, on the page on screen; 300 between 11 and 12, on a later one.
      { added: [work(100, 1.5), work(200, 7.5), work(300, 11.5)], gone: [] },
      { added: [], gone: ['200'] },
    ])

    assert.deepEqual(opened.map(w => w.id), ['7', '8', '9'])

    assert.deepEqual(added.shown.map(w => w.id), ['100', '7', '200'], 'the earlier page’s work goes first on this one')
    assert.deepEqual(added.order.slice(0, 6), ['1', '2', '3', '4', '5', '6'], 'no page before the one on screen changes')
    assert.deepEqual(added.order.slice(-2), ['300', '12'], 'a later page’s work goes in its place')
    assert.equal(added.page, 2)
    assert.equal(added.text, 'Work')
    assert.equal(added.workText, 'dragon')
    assert.deepEqual(added.searched.sort(), ['100', '200', '300'], 'the work-text search runs over the works added, and only those')

    assert.deepEqual(removed.shown, [
      { id: '100', collapsed: null },
      { id: '7', collapsed: null },
      { id: '200', collapsed: 'Moved to a later review' },
    ])
    assert.equal(removed.page, 2)
  })

  test('a gone work holds its slot across a rebuild, and comes back when it is merged again', async () => {
    const [, , , rebuilt, back] = await run([
      { added: [work(200, 7.5)], gone: [] },
      { added: [], gone: ['200'] },
      { rebuild: true },
      { added: [work(200, 7.5)], gone: [] },
    ])
    assert.deepEqual(rebuilt.shown, [
      { id: '7', collapsed: null },
      { id: '200', collapsed: 'Moved to a later review' },
      { id: '8', collapsed: null },
    ])
    assert.deepEqual(back.shown, [
      { id: '7', collapsed: null },
      { id: '200', collapsed: null },
      { id: '8', collapsed: null },
    ])
  })

  test('a work taken out by hand and merged again is shown', async () => {
    const [, , , again] = await run([
      { added: [], gone: ['8'] },
      { remove: '8' },
      { added: [work(8, 8)], gone: [] },
    ])
    assert.ok(again.shown.some(w => w.id === '8' && w.collapsed === null))
  })
})
