/**
 * The fandom index bundled with the extension: every canonical fandom's name,
 * lowercased, to its tag id. The build ships it gzipped, and extension files
 * are read with no `Content-Encoding`, so the unpacking is ours.
 */
export async function loadFandomIndex(): Promise<Record<string, number>> {
  const response = await fetch(browser.runtime.getURL('data/fandom-index.json.gz'))
  if (!response.ok || !response.body)
    throw new Error(`The bundled fandom index could not be read (${response.status})`)
  const json = response.body.pipeThrough(new DecompressionStream('gzip'))
  return await new Response(json).json() as Record<string, number>
}
