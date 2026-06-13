// Shared per-agent color assignment. The log view (app.js) and the pipeline
// view (pipeline.js) import this so the same agent renders in the same color
// across tabs — one module-level Map (ES modules are singletons) keeps the
// first-seen-order assignment consistent regardless of which view sees an
// agent first.
const PALETTE = [
  '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7',
  '#ff9e64', '#73daca', '#c0caf5',
];
const agentColors = new Map();

export function colorForAgent(agent) {
  if (!agent) return PALETTE[0];
  if (!agentColors.has(agent)) {
    agentColors.set(agent, PALETTE[agentColors.size % PALETTE.length]);
  }
  return agentColors.get(agent);
}

export { PALETTE };
