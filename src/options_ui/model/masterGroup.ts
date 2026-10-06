/** How the rows a master switch gates are drawn. */
export interface DependentState {
  /** Their controls take no input; their stored values are left as they are. */
  inert: boolean
  /** Why they are inert, naming the master by its title. */
  reason: string | null
  /** Their descriptions fold away, leaving the titles as a list of what the master governs. */
  folded: boolean
}

/**
 * The rows a master switch gates, given the master's title and state. While
 * the master is off they are inert and say why; their descriptions fold away
 * too, except while a settings search runs, since a hit may be in one.
 */
export function dependentState(master: { title: string, on: boolean }, searching: boolean): DependentState {
  if (master.on)
    return { inert: false, reason: null, folded: false }
  return { inert: true, reason: `Off while ${master.title} is off`, folded: !searching }
}
