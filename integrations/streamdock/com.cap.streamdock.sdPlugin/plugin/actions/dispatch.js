import { dispatch } from '../cap.js';
import { readState } from '../state.js';
import { iconDataUri } from '../icons.js';

const UUID = 'com.cap.streamdock.dispatch';
const busy = new Set();   // contexts with an in-flight run

function resolveTarget(settings) {
  if (settings.targetOverride) return settings.targetOverride;
  return readState().activeProject;
}

function finish(sd, ctx, agent, ok) {
  busy.delete(ctx);
  sd.setImage(ctx, iconDataUri(ok ? 'pass' : 'fail'), 0);
  sd.setTitle(ctx, ok ? 'done' : 'failed');
  setTimeout(() => { sd.setImage(ctx, iconDataUri('idle'), 0); sd.setTitle(ctx, agent); }, 4000);
}

export function registerDispatchAction(sd) {
  sd.on('willAppear', (ev) => {
    if (ev.action !== UUID) return;
    sd.setImage(ev.context, iconDataUri('idle'), 0);
    sd.setTitle(ev.context, ev.payload?.settings?.agent || 'Dispatch');
  });

  sd.on('keyDown', (ev) => {
    if (ev.action !== UUID) return;
    const ctx = ev.context;
    if (busy.has(ctx)) return;                      // ignore re-press while running
    const settings = ev.payload?.settings || {};
    const agent = settings.agent || 'scanner';
    const prompt = settings.prompt || 'Pick up the top ready ticket and proceed.';
    const target = resolveTarget(settings);
    if (!target) { sd.setImage(ctx, iconDataUri('warn'), 0); sd.setTitle(ctx, 'pick project'); return; }

    busy.add(ctx);
    sd.setImage(ctx, iconDataUri('running'), 1);
    sd.setTitle(ctx, agent);

    const run = dispatch({ agent, prompt, target, mode: settings.mode || 'stream' });
    run.events.on('state', (intent) => {
      if (intent.kind === 'activity') sd.setTitle(ctx, intent.activity.slice(0, 12));
    });
    run.done
      .then(({ ok }) => finish(sd, ctx, agent, ok))
      .catch(() => finish(sd, ctx, agent, false));
  });
}
