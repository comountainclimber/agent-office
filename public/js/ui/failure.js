// Why did a task fail? One small helper shared by the tasks tray, the "KNOCKED OUT!" card and the dialogue.
//
//   failureLines(outputTail, max = 4) -> string[]
//       The lines of a task's output that say why it failed: the LAST lines that read like the real error
//       (a CLI prints warnings first and the error last), else the last non-empty lines. Never more than `max`.
//   failureReason(task, { max } = {}) -> { lines: string[], text: string, signedOut: boolean, aboutModel: boolean }
//       The same, for a Task, with a fallback sentence when the output is empty.
//   looksSignedOut(outputTail) -> boolean
//   lastLines(outputTail, n = 3) -> string[]            (the plain tail; kept for older callers)
//
// The full output is one event away:  window.dispatchEvent(new CustomEvent('ao:open-task-output', { detail: { taskId } }))

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const ERRORISH = /\berr(or)?\b|\bfail(ed|ure|s)?\b|not supported|unsupported|unauthori[sz]ed|forbidden|\b40[0134]\b|\b5\d\d\b(?= |:|$)|sign(ed)? ?(in|out)|log(ged)? ?(in|out)|denied|invalid|no such|not found on|cannot|can't|could not|couldn't|panic|exception|fatal|rate limit|quota/i;
// Lines that mention a failure word but are only a warning on the way to the real error.
const WARNISH = /^\s*(warn(ing)?\b|note\b|hint\b|info\b|debug\b)|defaulting to|falling back|deprecated/i;
const LINE_MAX = 220;

function clean(outputTail) {
  return String(outputTail || '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
}

const clip = (l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX - 1) + '…' : l);

/** The last few non-empty lines of a task's output. */
export function lastLines(outputTail, n = 3) {
  return clean(outputTail).slice(-n).map(clip);
}

/** The lines that say why: the last error-looking ones, else the tail. */
export function failureLines(outputTail, max = 4) {
  const lines = clean(outputTail);
  if (!lines.length) return [];
  const isErr = (l) => ERRORISH.test(l) && !WARNISH.test(l);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isErr(lines[i])) { last = i; break; }
  if (last === -1) return lines.slice(-max).map(clip);
  // start at the earliest error-looking line of the same burst (within reach of the last one) …
  let first = last;
  for (let i = last - 1; i >= Math.max(0, last - 8); i--) if (isErr(lines[i])) first = i;
  // … and carry on through whatever follows it (detail, a hint what to do), up to `max` lines.
  // A long burst keeps its head and its last error line: the message, then the verdict.
  if (last - first >= max) return [...lines.slice(first, first + max - 1), lines[last]].map(clip);
  return lines.slice(first, first + max).map(clip);
}

/** Does this output read like a signed-out CLI? */
export function looksSignedOut(outputTail) {
  return /not logged in|logged out|please (run )?\/?log ?in|auth(entication)? (required|failed|error)|unauthori[sz]ed|\b401\b|sign(ed)? ?(in|out)|invalid api key|login required|run `?[a-z-]+ (auth )?login/i.test(String(outputTail || '').slice(-1500));
}

export function failureReason(task, { max = 4 } = {}) {
  const tail = task ? task.outputTail : '';
  let lines = failureLines(tail, max);
  if (!lines.length) lines = [`Exited${task && task.exitCode != null ? ` with code ${task.exitCode}` : ''} without saying why.`];
  const text = lines.join('\n');
  return {
    lines,
    text,
    signedOut: looksSignedOut(tail),
    aboutModel: /\bmodel\b/i.test(text),
  };
}
