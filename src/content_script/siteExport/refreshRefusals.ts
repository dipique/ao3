/**
 * Why the site export's job refused to store a list it refreshed, said to the
 * reader as the reason it stopped. Each leaves the stored copy as it was, and
 * says what to do before trying again.
 */
export const REFRESH_REFUSED = {
  /** A list only the reader's own account sees, read signed out. */
  loggedOut: 'AO3 served the signed-out view, and this list is only visible to your own account. '
    + 'Sign in to AO3 and try again — your stored copy of the list has been left as it was.',
  /** A listing that came back with nothing on it. */
  emptied: 'AO3 returned this list with no works in it, so it was left as it was rather than emptied. '
    + 'Open the list on AO3 to check it, then try again.',
  /** Read works, which is made from the reader's marks, with Work marks off. */
  marksOff: 'This list is made from your marks, and Work marks is switched off, so it was left as it was rather than emptied. '
    + 'Switch Work marks on, under Reading, then try again.',
} as const
