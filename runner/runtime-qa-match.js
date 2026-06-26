// Pure: given the member registry + a PR's changed files, return the members whose
// surface changed. `always` members are returned regardless. Mirrors detector-match.js
// and reuses its glob engine. Zero deps beyond globToRegExp.
import { globToRegExp } from './detector-match.js';

/**
 * @param {Array<{id,agent,globs?:string[],always?:boolean}>} members
 * @param {Array<{path:string}>} changedFiles
 * @returns {Array} active members (registry order)
 */
export function matchMembers(members, changedFiles) {
  const paths = (changedFiles || []).map(f => f.path);
  return members.filter(m => {
    if (m.always) return true;
    const res = (m.globs || []).map(globToRegExp);
    return paths.some(p => res.some(re => re.test(p)));
  });
}
