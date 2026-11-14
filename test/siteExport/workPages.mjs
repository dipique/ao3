/**
 * AO3 work pages in miniature, for the tests that parse one: the sanitizer, and
 * the fetch that hands it every page of a work's comments.
 */

/**
 * A work page in miniature: the meta block and `#workskin` we keep, wrapped in
 * the chrome we don't (navigation with a "Mark for Later" form, the kudos and
 * comment furniture, AO3's scripts), plus the things a work's own author HTML
 * can carry — an inline handler and a `javascript:` link.
 */
export const PAGE = `<!DOCTYPE html><html><head>
<title>Work</title>
<script src="/javascripts/application.js"></script>
<style>.user-1 { display: none }</style>
</head><body class="works-show logged-in">
<div id="header"><ul class="menu"><li><a href="/works/search">Search</a></li></ul></div>
<div id="main" class="works-show region">
  <ul class="work navigation actions">
    <li class="mark"><form class="button_to" method="post" action="/works/42/mark_for_later">
      <button type="submit">Mark for Later</button>
      <input type="hidden" name="authenticity_token" value="SECRET">
    </form></li>
  </ul>
  <div class="wrapper"><dl class="work meta group">
    <dt class="fandom tags">Fandom:</dt>
    <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/Some%20Fandom/works">Some Fandom</a></li></ul></dd>
    <dt class="stats">Stats:</dt>
    <dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">666</dd><dt class="chapters">Chapters:</dt><dd class="chapters">2/2</dd></dl></dd>
  </dl></div>
  <div id="work-skin" class="wrapper"><div id="workskin">
    <div class="preface group">
      <h2 class="title heading">A Title</h2>
      <h3 class="byline heading"><a rel="author" href="/users/someone/pseuds/someone">someone</a></h3>
      <div class="summary module"><blockquote class="userstuff"><p>A summary.</p></blockquote></div>
    </div>
    <div id="chapters" role="article">
      <div class="chapter" id="chapter-1">
        <div class="chapter preface group"><h3 class="title"><a href="/works/42/chapters/1">Chapter 1</a></h3></div>
        <div class="userstuff module">
          <p>First chapter. <a href="#chapter-2">Skip ahead</a>, or see <a href="/works/99">that other work</a>.</p>
          <p onclick="alert(1)">Clicky.</p>
          <p><a href="javascript:alert(2)">Do not</a></p>
          <p><a href="java&#10;script:alert(3)">Nor this</a></p>
          <p><a href="&#9;VBScript:alert(4)">Nor this either</a></p>
          <img src="/images/skins/thing.png" alt="a thing">
        </div>
      </div>
      <div class="chapter" id="chapter-2">
        <div class="userstuff module"><p>Second chapter.</p></div>
      </div>
    </div>
    <div class="afterword preface group"><div class="notes module"><blockquote class="userstuff"><p>End notes.</p></blockquote></div></div>
  </div></div>
  <div id="feedback" class="feedback">
    <form id="new_kudo" action="/kudos" method="post"><button type="submit">Kudos</button></form>
    <div id="kudos">someone left kudos</div>
    <form class="new_comment" action="/works/42/comments" method="post"><textarea name="comment[comment_content]"></textarea></form>
  </div>
</div>
<div id="footer"><p>AO3 footer</p></div>
</body></html>`

/** One comment as AO3 lists it: byline, icon, text, and the actions under it. */
export function comment(id, text) {
  return `<li class="comment group even" role="article" id="comment_${id}">
    <h4 class="heading byline"><a href="/users/reader${id}/pseuds/reader${id}">reader${id}</a> <span class="parent">on Chapter 1</span> <span class="posted datetime"><span class="date">12</span> <abbr class="month" title="March">Mar</abbr> <span class="year">2026</span></span></h4>
    <div class="icon"><a href="/users/reader${id}/pseuds/reader${id}"><img alt="" class="icon" src="/images/skins/iconsets/default/icon_user.png"></a></div>
    <blockquote class="userstuff"><p>${text}</p></blockquote>
    <h5 class="landmark heading">Comment Actions</h5>
    <ul class="actions" id="navigation_for_comment_${id}"><li><a href="/comments/${id}">Thread</a></li><li><a href="/comments/add_comment_reply?id=${id}">Reply</a></li></ul>
    <div id="add_comment_reply_placeholder_${id}" title="reply to this comment" class="hidden"></div>
  </li>`
}

/** AO3's page list for comments, on page `current` of `pages`. */
export function pagination(current, pages) {
  const link = n => `/works/42?page=${n}&amp;show_comments=true&amp;view_full_work=true#comments`
  const items = Array.from({ length: pages }, (_, i) => i + 1)
    .map(n => n === current ? `<li><span class="current">${n}</span></li>` : `<li><a href="${link(n)}">${n}</a></li>`)
  return `<ol class="pagination actions" role="navigation" title="pagination">${items.join('')}<li class="next"><a rel="next" href="${link(Math.min(current + 1, pages))}">Next →</a></li></ol>`
}

/** {@link PAGE} as `show_comments=true` returns it: `threads` (markup) on page `current` of `pages`. */
export function withComments(threads, { current = 1, pages = 1 } = {}) {
  const list = pages > 1 ? pagination(current, pages) : ''
  return PAGE.replace(
    '<div id="kudos">someone left kudos</div>',
    `<div id="kudos">someone left kudos</div>
    <div id="comments_placeholder"><h3 class="landmark heading">Comments</h3>${list}<ol class="thread">${threads}</ol>${list}</div>`,
  )
}

/** A comment and a reply to it, the reply nested the way AO3 nests one. */
export const THREAD = `${comment(1, 'Loved it.')}<li><ol class="thread">${comment(2, 'Me too.')}</ol></li>`
