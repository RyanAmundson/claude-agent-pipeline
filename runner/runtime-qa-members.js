// The runtime-QA fan-out members. Each member owns one runtime concern and maps to an
// agent that drives the running app via agent-browser and emits a JSON verdict (the
// runner parses it). `globs` = changed-file surfaces that activate the member;
// `always: true` = runs every PR regardless of the diff.

export const MEMBERS = [
  { id: 'interaction', agent: 'interaction-validator', globs: ['src/**/*.tsx'] },
  { id: 'visual',      agent: 'visual-validator',      globs: ['src/**/*.tsx'] },
  { id: 'state',       agent: 'state-validator',       globs: ['src/**/*.tsx'] },
  { id: 'network',     agent: 'network-validator',     globs: ['src/**/*.tsx', 'src/**/[apis]/**', 'src/**/[services]/**'] },
  { id: 'data',        agent: 'data-validator',        always: true },
  { id: 'responsive',  agent: 'responsive-validator',  globs: ['src/**/*.tsx'] },
  { id: 'a11y',        agent: 'a11y-validator',        globs: ['src/**/*.tsx'] },
  { id: 'perf',        agent: 'perf-validator',        globs: ['src/**/*.tsx'] },
];
