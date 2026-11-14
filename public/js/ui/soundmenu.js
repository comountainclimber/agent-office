// The sound menu: a small popover hung from the SND button in the top bar.
// OFF / CRITICAL / ALL with what each one means, four volume steps, and TEST. Every choice is heard at once.
import { h, setAttr, setText, setHidden } from './dom.js';
import { openPopover, radioGroup } from './modal.js';
import { VOLUME_STEPS } from './sound.js';

export const SOUND_OPTIONS = [
  { value: 'off', label: 'OFF', short: 'OFF', blurb: 'Silence.' },
  { value: 'critical', label: 'CRITICAL', short: 'CRIT', blurb: 'An agent needs you, a task failed, the connection dropped.' },
  { value: 'all', label: 'ALL', short: 'ALL', blurb: 'Also finished tasks, arrivals and meetings.' },
];

/** openSoundMenu({ anchor, sound, onClose? }) -> popover */
export function openSoundMenu({ anchor, sound, onClose }) {
  const pop = openPopover({ anchor, className: 'pop-sound', label: 'Sound cues', align: 'end', onClose: () => { off(); if (onClose) onClose(); } });

  const levels = radioGroup({
    label: 'Which cues play',
    className: 'snd-levels',
    value: sound.level,
    options: SOUND_OPTIONS.map((o) => ({
      value: o.value,
      render(btn) {
        btn.classList.add('menu-item', 'snd-level');
        btn.setAttribute('aria-label', `${o.label}: ${o.blurb}`);
        btn.append(
          h('span', { class: 'ico ico-cursor menu-cursor', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'snd-level-name', text: o.label }),
          h('span', { class: 'snd-level-blurb', text: o.blurb }));
      },
    })),
    onChange: (v) => sound.setLevel(v),
  });

  const vol = radioGroup({
    label: 'Volume',
    className: 'snd-vols',
    value: String(sound.volume),
    options: Array.from({ length: VOLUME_STEPS }, (_, i) => ({
      value: String(i + 1),
      render(btn) {
        btn.classList.add('snd-vol');
        btn.setAttribute('aria-label', `Volume ${i + 1} of ${VOLUME_STEPS}`);
        btn.title = `Volume ${i + 1} of ${VOLUME_STEPS}`;
        btn.append(h('span', { class: 'snd-vol-bar', attrs: { 'aria-hidden': 'true' } }));
        btn.style.setProperty('--n', String(i + 1));
      },
    })),
    onChange: (v) => sound.setVolume(Number(v)),
  });

  const testNote = h('span', { class: 'snd-test-note', attrs: { role: 'status' } });
  const test = h('button', {
    class: 'btn btn-mini snd-test', type: 'button', text: 'TEST', title: 'Play the needs-you chirp at this volume',
    on: { click: () => {
      const ok = sound.test();
      setText(testNote, ok ? 'That is the needs-you chirp.' : 'No audio here: the browser would not start it.');
      setHidden(testNote, false);
    } },
  });

  pop.el.append(
    h('h3', { class: 'pop-title', text: 'SOUND CUES' }),
    levels.el,
    h('div', { class: 'snd-row' }, h('span', { class: 'snd-row-label', text: 'VOLUME' }), vol.el, test),
    testNote,
    h('p', { class: 'pop-hint', text: 'S mutes / unmutes · Shift+S steps through the three' }));
  setHidden(testNote, true);

  function paint({ level, volume }) {
    if (levels.value !== level) levels.set(level, { silent: true });
    if (vol.value !== String(volume)) vol.set(String(volume), { silent: true });
    const isOff = level === 'off';
    for (const [val, btn] of vol.buttons) {
      btn.disabled = isOff;
      setAttr(btn, 'data-on', !isOff && Number(val) <= volume ? 'true' : null);
    }
    // radioGroup's roving tabindex does not know about the disabled row
    const cur = vol.buttons.get(String(volume));
    if (cur) cur.tabIndex = isOff ? -1 : 0;
    test.disabled = isOff;
    if (isOff) setHidden(testNote, true);
  }
  const off = sound.onChange(paint);

  pop.place();
  (levels.buttons.get(sound.level) || test).focus();
  return pop;
}
