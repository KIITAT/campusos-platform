/**
 * Tables this module reads but does not own. Re-exported through one file so
 * the cross-module dependency surface is a single, greppable list rather than
 * scattered imports -- and so a change in academic breaks here, loudly, in one
 * place.
 */
export {
  courses,
  offerings,
  programs,
  sectionMembers,
  sections,
  terms,
} from '@campusos/module-academic/schema'
export { institutions } from '@campusos/db'
