// Pure: given detector registry entries + changed files (path+content), return
// the detectors whose glob matches a file AND whose prefilter pattern appears in it.
// Zero deps; minimal glob support (**, *, ?, {a,b}).

/** Convert a glob to an anchored RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map(escapeRe).join('|');
      re += `(?:${alts})`; i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) { return s.replace(/[.+^$()|[\]\\]/g, '\\$&'); }

/**
 * @param {Array<{id,glob,prefilterPattern,mode}>} registry
 * @param {Array<{path:string, content:string}>} files
 * @param {{mode?: 'sweep'|'diff'}} [opts]
 * @returns {Array} matched registry entries (deduped)
 */
export function matchDetectors(registry, files, opts = {}) {
  const matched = new Map();
  for (const d of registry) {
    if (opts.mode && d.mode !== 'both' && d.mode !== opts.mode) continue;
    const globRe = globToRegExp(d.glob);
    let preRe;
    try { preRe = new RegExp(d.prefilterPattern); } catch { continue; }
    for (const f of files) {
      if (globRe.test(f.path) && preRe.test(f.content)) { matched.set(d.id, d); break; }
    }
  }
  return [...matched.values()];
}
