// The background's sync half, as one bundle for an options page under test:
// the engine as the background wires it, with the real backups, over whatever
// `browser` the page has.
export { onStorageChanged, resolveHeldSync, setSyncEnabled } from '../../src/background/syncEngine.ts'
