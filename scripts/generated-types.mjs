/**
 * The parsing half of `check-generated-types.mjs`: which names a generated stub
 * declares, and whether the module it points at exports them. Pure, so the
 * suite can run it on fixtures; the script supplies the files.
 */

/**
 * The two shapes the generators emit:
 *
 *     const Foo: typeof import('../mod').Foo          // auto-imports.d.ts
 *     Foo: typeof import('./../Foo.vue')['default']   // components.d.ts
 */
const DECLARATION = /^\s*(?:const\s+|readonly\s+)?(\w+)\s*:\s*typeof\s+import\('([^']+)'\)(?:\['(\w+)'\]|\.(\w+))?/gm

/** Words after which a `/` starts a regex literal rather than dividing. */
const BEFORE_REGEX_WORDS = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])

/** Punctuation after which a `/` starts a regex literal rather than dividing. */
const BEFORE_REGEX_MARKS = '(,=:[!&|?{};+-*%<>~^}'

/**
 * `source` with its comments taken out, so a doc comment line that happens to
 * end on "export", followed by the next line's leading `*`, can't read as
 * `export *`.
 *
 * Strings, template literals (substitutions included) and regex literals are
 * copied whole, since a `//` or `/*` inside one opens no comment, and a quote
 * inside a regex opens no string. Telling a regex from a division is a guess
 * from what precedes the `/`; a guessed regex that doesn't close on its own line
 * was a division after all, and is read again as one.
 */
function stripComments(source) {
  let out = ''
  let i = 0

  function regexMayStart() {
    let end = out.length
    while (end > 0 && /\s/.test(out[end - 1]))
      end--
    if (end === 0)
      return true
    let start = end
    while (start > 0 && /[\w$]/.test(out[start - 1]))
      start--
    return start < end
      ? BEFORE_REGEX_WORDS.has(out.slice(start, end))
      : BEFORE_REGEX_MARKS.includes(out[end - 1])
  }

  function quoted(quote) {
    const start = i++
    while (i < source.length && source[i] !== quote && source[i] !== '\n')
      i += source[i] === '\\' ? 2 : 1
    out += source.slice(start, ++i)
  }

  function regex() {
    const start = i++
    let inClass = false
    while (i < source.length && source[i] !== '\n') {
      const c = source[i]
      i += c === '\\' ? 2 : 1
      if (c === '[') {
        inClass = true
      }
      else if (c === ']') {
        inClass = false
      }
      else if (c === '/' && !inClass) {
        out += source.slice(start, i)
        return
      }
    }
    out += '/'
    i = start + 1
  }

  function template() {
    out += source[i++]
    while (i < source.length) {
      const c = source[i]
      if (c === '\\') {
        out += source.slice(i, i + 2)
        i += 2
      }
      else if (c === '$' && source[i + 1] === '{') {
        out += '${'
        i += 2
        code(true)
      }
      else {
        out += c
        i++
        if (c === '`')
          return
      }
    }
  }

  /** Copies code up to the end of `source`, or in a substitution, past its closing brace. */
  function code(substitution) {
    let depth = 0
    while (i < source.length) {
      const c = source[i]
      const next = source[i + 1]
      if (c === '/' && next === '/') {
        const end = source.indexOf('\n', i)
        i = end === -1 ? source.length : end
      }
      else if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? source.length : end + 2
        out += ' '
      }
      else if (c === '\'' || c === '"') {
        quoted(c)
      }
      else if (c === '`') {
        template()
      }
      else if (c === '/' && regexMayStart()) {
        regex()
      }
      else {
        out += c
        i++
        if (substitution && c === '{')
          depth++
        else if (substitution && c === '}' && depth-- === 0)
          return
      }
    }
  }

  code(false)
  return out
}

/**
 * Whether `source` exports `name`.
 *
 * Generous on purpose: named declarations, export clauses with or without `as`,
 * and — where a file re-exports everything from somewhere else — a shrug. The
 * case this exists to catch is a name that appears nowhere as an export at all.
 * Comments are prose, and are not searched.
 */
function exportsName(source, name) {
  source = stripComments(source)
  if (new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function|class|type|interface|enum)\\s+${name}\\b`).test(source))
    return true
  for (const block of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const clause of block[1].split(',')) {
      if ((clause.split(/\s+as\s+/).at(-1) ?? '').trim() === name)
        return true
    }
  }
  return /\bexport\s+\*/.test(source)
}

/**
 * One message per name the stub `file` (whose text is `stub`) declares but its
 * module doesn't export. `readModule` maps an import specifier, relative to the
 * stub, to that module's source, or to null when no file answers to it.
 */
export function staleDeclarations(file, stub, readModule) {
  const problems = []
  for (const [, declared, spec, bracketed, dotted] of stub.matchAll(DECLARATION)) {
    // A bare specifier is a package, whose exports are its own business.
    if (!spec.startsWith('.'))
      continue

    const module = readModule(spec)
    if (module === null) {
      problems.push(`${file}: '${declared}' points at '${spec}', and no file answers to it`)
      continue
    }

    // An SFC's default export is the component; that the file resolves is the
    // whole of the question. Anything else is checked by name.
    const name = bracketed ?? dotted ?? declared
    if (name === 'default' || spec.endsWith('.vue'))
      continue
    if (!exportsName(module, name))
      problems.push(`${file}: declares '${declared}', but '${spec}' does not export '${name}'`)
  }
  return problems
}
