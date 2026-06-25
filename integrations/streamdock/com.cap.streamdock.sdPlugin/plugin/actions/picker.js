import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../cap.js';
import { readState, setActiveProject } from '../state.js';
import { iconDataUri } from '../icons.js';

const UUID = 'com.cap.streamdock.picker';

export function registerPickerAction(sd) {
  let projects = [];
  let index = 0;
  let ctx = null;

  function roots(settings) {
    return (settings?.roots || join(homedir(), 'Code')).split(',').map((s) => s.trim());
  }
  function render() {
    if (!ctx) return;
    const cur = projects[index];
    sd.setImage(ctx, iconDataUri('category'));
    sd.setTitle(ctx, cur ? cur.name : 'no pipeline');
  }
  function syncIndexToActive() {
    const active = readState().activeProject;
    const i = projects.findIndex((p) => p.path === active);
    if (i >= 0) index = i;
  }

  sd.on('willAppear', (ev) => {
    if (ev.action !== UUID) return;
    ctx = ev.context;
    projects = discoverProjects(roots(ev.payload?.settings));
    syncIndexToActive();
    if (projects[index] && !readState().activeProject) setActiveProject(projects[index].path);
    render();
  });

  // Rotate the dial to move the highlight.
  sd.on('dialRotate', (ev) => {
    if (ev.action !== UUID || !projects.length) return;
    const ticks = Math.trunc(ev.payload?.ticks ?? 1);
    index = (index + ticks % projects.length + projects.length) % projects.length;
    render();
  });

  // Press dial OR tap the strip to commit the highlighted project.
  const commit = (ev) => {
    if (ev.action !== UUID || !projects[index]) return;
    setActiveProject(projects[index].path);
    sd.setTitle(ctx, '→ ' + projects[index].name);
    setTimeout(render, 1200);
  };
  sd.on('dialPress', commit);
  sd.on('touchTap', commit);
}
