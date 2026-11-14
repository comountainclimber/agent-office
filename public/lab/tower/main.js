// TOWER concept: cutaway building, one floor per project.
import { connectFeed } from '../shared/feed.js';
import { createWorld } from './world.js';
import { createUI } from './ui.js';

let ui = null;
let feed = null;
let lastLayout = null;

const world = createWorld(document.getElementById('world'), {
  onSelect: (id) => ui?.select(id),
  onNewTask: (where) => ui?.openNewTask(where || ''),
  onFloors: () => ui?.refreshIndex(),
  onLayout: (info) => { lastLayout = info; ui?.setLayout(info); },
});

ui = createUI({ world, getFeed: () => feed });
if (lastLayout) ui.setLayout(lastLayout);

let queued = null;
feed = connectFeed({
  onState(state) {
    if (!feed) { queued = state; return; }
    world.setState(state);
    ui.setState(state);
  },
  onMode(mode) { ui.setMode(mode); },
});
ui.setMode(feed.mode);
if (queued) { world.setState(queued); ui.setState(queued); }

if (document.fonts?.ready) document.fonts.ready.then(() => { if (lastLayout) ui.setLayout(lastLayout); });
// dev aid: ?debug exposes the world for poking at from the console
if (new URLSearchParams(location.search).has('debug')) window.__tower = { world, ui, get feed() { return feed; } };
