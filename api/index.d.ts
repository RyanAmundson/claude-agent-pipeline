// claude-agent-pipeline — public Node API types (v1).
// Hand-authored to keep the package zero-dep at runtime.

import { EventEmitter } from 'node:events';

export const API_VERSION: 1;

export type QueueState =
  | 'needs-triage'
  | 'needs-review'
  | 'needs-work'
  | 'in-progress'
  | 'needs-test-review'
  | 'needs-code-review'
  | 'needs-feedback'
  | 'ready-for-human'
  | 'done'
  | 'needs-info';

export const STATES: ReadonlyArray<QueueState>;

export interface TicketSource {
  agent?: string;
  category?: string;
  file?: string;
  line?: number;
  [k: string]: unknown;
}

/** One append-only review comment on a ticket (filesystem backend). */
export interface TicketComment {
  author: string;
  verdict?: 'pass' | 'fail' | null;
  body: string;
  at: string;
}

export interface Ticket {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  source?: TicketSource;
  pr_url?: string | null;
  /** Filesystem-backend fields (CAP 0.3.0). */
  branch?: string | null;
  base?: string | null;
  worktree?: string | null;
  comments?: TicketComment[];
  stale_count?: number;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface TicketWithState extends Ticket {
  state: QueueState;
}

export interface AgentActivitySummary {
  active: number;             // count currently in `in-progress`
  owned: number;              // total tickets attributed to this agent
  recent: Array<{
    id: string;
    title: string | null;
    state: QueueState;
    updatedAt: string | null;
  }>;
  /** Live runs currently dispatched for this agent (empty when none). */
  runs: Array<{
    runId: string;
    status: RunStatus;
    startedAt: string;
    lastActivity: string | null;
  }>;
}

export interface Agent {
  name: string;
  title: string;
  stage: string | null;
  requires: string[];
  optional: string[];
  role: string | null;
  input: string | null;
  output: string | null;
  provenance: string;
  scope: string | null;
  docPath?: string;
  activity: AgentActivitySummary;
}

export interface Snapshot {
  apiVersion: 1;
  target: string;
  generatedAt: string;
  states: ReadonlyArray<QueueState>;
  agents: Agent[];
  tickets: {
    byState: Record<QueueState, Ticket[]>;
    count: number;
  };
  runs: {
    active: Run[];
    completed: Run[];
    activeCount: number;
  };
  /**
   * The latest orchestrator cycle (last line of `cycles.jsonl`), or null if none.
   * On non-filesystem backends this carries the queue-state `counts` and the
   * `running` agents the watcher cannot otherwise see. Updated live by
   * `cycle.report` watcher events.
   */
  cycle: CycleEntry | null;
  /** Per-state deltas of `cycle.counts` vs the prior cycle, or null. */
  cycleDeltas: Record<string, number> | null;
  /** Orchestrator supervisor state, or null if never started. */
  orchestrator: OrchestratorStatus | null;
}

// ─── runs ──────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed';

export type RunLifecycleState = 'active' | 'completed';

export const RUN_STATES: ReadonlyArray<RunLifecycleState>;

export interface RunCost {
  usd?: number;
  durationMs?: number;
  tokens?: Record<string, number>;
}

export interface Run {
  runId: string;
  agent: string;
  prompt: string;
  target: string;
  pid: number | null;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  cost?: RunCost | null;
  lastEventAt?: string | null;
  lastActivity?: string | null;
  error?: string;
  /** Present on results from getRun(); identifies which lifecycle dir the run is in. */
  state?: RunLifecycleState;
  [k: string]: unknown;
}

/** Normalized event extracted from a `claude -p --output-format stream-json` line. */
export interface RunEvent {
  ts: string;
  type: string;        // 'system' | 'assistant' | 'user' | 'result' | …
  subtype?: string | null;
  activity?: string;
  toolUse?: { name: string; id?: string };
  cost?: RunCost;
  result?: { subtype?: string; isError?: boolean };
  raw: unknown;        // the original stream-json payload
}

// ─── events ────────────────────────────────────────────────────────────────

export type WatcherEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'ticket.upsert'; state: QueueState; ticket: Ticket }
  | { type: 'ticket.move'; id: string; from: QueueState; to: QueueState; ticket: Ticket }
  | { type: 'ticket.remove'; id: string; state: QueueState }
  | { type: 'run.start'; runId: string; state: RunLifecycleState; run: Run }
  | { type: 'run.update'; runId: string; state: RunLifecycleState; run: Run }
  | { type: 'run.complete'; runId: string; from: RunLifecycleState; to: RunLifecycleState; run: Run }
  | { type: 'run.fail';     runId: string; from: RunLifecycleState; to: RunLifecycleState; run: Run }
  | { type: 'run.kill';     runId: string; from: RunLifecycleState; to: RunLifecycleState; run: Run }
  | { type: 'run.remove';   runId: string; state: RunLifecycleState }
  | { type: 'cycle.report'; cycle: CycleEntry }
  | { type: 'orchestrator.changed'; orchestrator: OrchestratorStatus };

/** Orchestrator lifecycle state, persisted in `.pipeline/runs/orchestrator.state.json`. */
export interface OrchestratorStatus {
  state: 'running' | 'paused' | 'stopped';
  supervisorPid: number | null;
  cadence: 'initial' | 'idle' | null;
  lastCycleAt: string | null;
  lastCycleNumber: number | null;
  nextFireAt: string | null;
  changedAt: string;
}

/** One orchestrator cycle, as appended to `.pipeline/runs/cycles.jsonl`. */
export interface CycleEntry {
  v: 1;
  cycle: number;
  /** ISO-8601 UTC, second precision. */
  at: string;
  backend: string;
  /** Non-zero queue-state counts only. */
  counts: Record<string, number>;
  dispatched: { agent: string; item?: string }[];
  running: { agent: string; item?: string; minutes?: number }[];
  awaiting: string[];
  notes: string[];
  nextCheckSeconds?: number;
}

// ─── options ───────────────────────────────────────────────────────────────

export interface ApiOptions {
  /** Absolute or relative path to the host project (the one with `.pipeline/queue/`). */
  target: string;
  /** Path to the claude-agent-pipeline package root. Defaults to the installed package. */
  pluginRoot?: string;
}

export interface WatcherOptions extends ApiOptions {
  /** Debounce window for fs.watch coalescing. Default 50ms. */
  debounceMs?: number;
  /** Reconciliation scan interval — belt-and-suspenders for dropped fs events. Default 60000ms. */
  reconcileMs?: number;
}

export interface Watcher extends EventEmitter, AsyncIterable<WatcherEvent>, AsyncIterator<WatcherEvent> {
  close(): void;
  on(event: 'event', listener: (e: WatcherEvent) => void): this;
  on(event: 'snapshot', listener: (snap: Snapshot) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

// ─── functions ─────────────────────────────────────────────────────────────

export function readSnapshot(opts: ApiOptions): Snapshot;
export function readOrchestratorState(target: string): OrchestratorStatus | null;
export function getTicket(opts: ApiOptions, id: string): (Ticket & { state: QueueState }) | null;
export function getAgent(opts: ApiOptions, name: string): Agent | null;
export function createWatcher(opts: WatcherOptions): Watcher;
export function listRuns(opts: ApiOptions): { active: Run[]; completed: Run[] };
export function getRun(opts: ApiOptions, runId: string): Run | null;
export function getRunEvents(opts: ApiOptions, runId: string): RunEvent[];
