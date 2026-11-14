// Agent Office — the canvas world.
//
//   createOffice(canvas, { insets? }) -> {
//     setState(state)            full OfficeState snapshot; diffed by session.id / subagent id.
//                                Reads Session.label, Session.groupId, state.groups and the shell-derived
//                                Session.unanswered (all optional).
//     select(id | null)          highlight + pan to a session, or `${sessionId}#${subagentId}`
//     onSelect(fn)               fn(id | null) when the user clicks a character (or its name tag, the card on
//                                its empty desk, its room's banner) / empty floor; returns an unsubscribe fn
//     resize()                   re-measure the canvas (also done automatically via ResizeObserver)
//     destroy()
//     // extras
//     setInsets({top,right,bottom,left})   CSS px of fixed app chrome laid over the canvas; the office is planned
//                                          for what is left (see "The floor plan" below) and nothing that
//                                          matters is ever placed under an inset
//     setOverlay({right,bottom})           CSS px of panels that slide OVER the office (opened dialogue, transcript).
//                                          The camera moves the least that keeps the selected character AND the top
//                                          of its zone (room banner / pod sign / BREAK ROOM sign) between the chrome
//                                          and the panel; if both cannot fit, the office glides one scale step down
//                                          and stays there for as long as that selection and the panel last.
//                                          Opening and closing are followed at once; while a panel is open, a change
//                                          of its size is followed once it has kept still for 150 ms (one camera move
//                                          to the final size, however many times the shell calls this meanwhile).
//     highlightGroup(groupId | null)       OPTIONAL, for filter chips. Members of that group stay bright (their pod,
//                                          their meeting rooms, and themselves wherever they are); everyone else and
//                                          the scenery dim. Pass a Group.id, the literal 'none' for the sessions
//                                          without a group, or null to clear. The world never changes it by itself
//                                          once an onGroupSelect listener exists.
//     onGroupSelect(fn)                    OPTIONAL. fn(groupId) when the user clicks a pod's sign in the bullpen:
//                                          a Group.id, or 'none' for the default bullpen's sign. Returns an
//                                          unsubscribe fn. The world does not highlight on its own when someone
//                                          listens (call highlightGroup from the listener); with no listener a
//                                          click on a sign toggles the highlight by itself.
//     onPanChange(fn)                      OPTIONAL. fn(panning: boolean) whenever the office starts or stops being
//                                          bigger than the window (it can then be dragged, wheeled, moved with the
//                                          arrow keys, or paged with the chevron tabs the world draws at the cut
//                                          edges). For a hint in the shell. Returns an unsubscribe fn. The current
//                                          value is getInfo().panning.
//     setTimeScale(n)            fast-forward walking/animation (dev harness)
//     setReducedMotion(bool|null)
//     getInfo()                  scale, world size, camera, counts, frame cost, `highlight`, and `pods`:
//                                [{ groupId | 'none', name, members, cols, rows, desks, stacked,
//                                   sign: {x,y,w,h} CSS px | null,
//                                   rect: {x,y,w,h}, seats: [{ i, x, y, owner: session id | null }] }]
//                                (cols / rows = columns / desk rows in use, stacked = it sits under another pod;
//                                rect / seats = where the pod and each of its desks stand when nothing is
//                                gliding, CSS px), plus
//                                `panning` (boolean: the office is bigger than the window),
//                                `layout` { rev, cause, at, pending }: the floor plan in force. rev counts
//                                  re-plans; cause = 'boot' | 'first' | 'viewport' | 'group' | 'overflow' | 'quiet',
//                                `origin` {x,y} (the office's top-left corner) and `rooms`
//                                  [{ i, x, y, w, owner, closing }] (CSS px, at rest),
//                                `clock` (world seconds simulated), `walking` (characters on the move) and
//                                `sliding` (furniture / rooms still gliding to their place)
//     locate(id)                 CSS-px position of a character on the canvas, or null ({x, y, walking})
//     advance(seconds)           step + draw synchronously (tests)
//   }
//   drawPortrait(canvas, session, subagent?)   bust close-up with the same deterministic look
//
// Groups in the office: every group that has sessions gets a "pod" (a rug exactly as big as its desks, in the
// group's tint taken towards carpet grey and edged in its dark shade, with a standing sign: NAME + member
// count on a dark plate with a stripe of the group colour; the big font when the name fits, the sign may
// overhang its rug, else the small font, "…" only past that, and the whole name while the pointer is on it),
// in `group.order`; sessions without a group sit in the default pod (grey rug, BULLPEN) after them. A group's
// colour only ever appears as that rug, the sign's stripe and the thin stripe under name tags and room
// banners: never as a bright filled plate. A session keeps its desk while its group does not change; when it
// changes, the session walks to a desk in the new pod.
//
// The floor plan is memory. Each pod stands in a slot (where, how many columns and rows) that it keeps.
//   - The office runs from the left edge of the usable area to its right edge, so its corner never depends
//     on what stands in it; the floor right of the last pod is a rec corner (plant, whiteboard, ping-pong
//     table, bench: hung from the right-hand wall) and is where the pods grow.
//   - Arrivals, departures, meetings starting or ending and status changes never move anything: a newcomer
//     takes a free desk (every pod keeps one spare where the floor allows: free desks are capped at one,
//     two when someone left a gap), else the pod takes the floor below it or a column to its right; the
//     default pod's shape is fixed once chosen and grows by whole columns. A new pod goes right of the last
//     one, or under a short one. A pod that empties gives its slot back and nobody closes the gap.
//   - Meeting rooms: every meeting that is on, plus the free (dimmed) rooms of earlier ones, up to the most
//     there were at once this session and never wider than the window. Rooms keep their index; a room's
//     banner only turns to "ROOM n · FREE" when the last of its crew has walked out of the door.
//   - Everything is planned afresh, in ONE eased move (pods glide as blocks, a single desk that changes
//     places is carried under a small puff of dust, the scale glides), only when:
//       'first'     the first people arrive,
//       'viewport'  the window, the insets or the display change (the furniture stays as it is if it can),
//       'group'     the user changes groups (a session's group, the group list or its order),
//       'overflow'  someone cannot be seated in place, or a meeting has stood outside the window for 30 s.
//                   Slots are kept even then when they can be: if the furniture exactly as it stands has
//                   room for the newcomer a scale step (or two) smaller, only the scale changes,
//       'quiet'     after 3 minutes without anybody new in which fewer desks would do: the gaps close and
//                   the office is drawn bigger again if it now can be.
//     In the middle of things ('group', 'overflow') the scale is kept whenever anything fits at it and never
//     goes up. getInfo().layout says which of these happened last.
//
// Scale: whole device pixels per art pixel, at most 4 CSS px, chosen so that the office fits with room for
// the next couple of arrivals (2-5 desk rows, small pods stacked or not, with or without spare desks). The
// floor is 2 CSS px; on displays where 1.5 CSS px is still whole device pixels (2x and denser) that half step
// is taken when the office would be at most ~15% too wide at 2. Only past that does the office scroll
// sideways at the floor scale: `panning` is then true, the cut edges are shaded and carry a big chevron tab
// (yellow with "!" and a count when someone out there needs you; a click pages that way).
//
// Colour rules (the shared ones in server/contract.mjs):
//   bright yellow = needs you, nothing else. A waiting agent's name plate (a room's banner for an orchestrator)
//     turns yellow with dark text, a "!" bubble hops beside its head and its hand is up; the flash is between
//     that yellow and one step dimmer, never another hue. `session.unanswered === true` on an agent that is no
//     longer 'waiting' gets a small, steady yellow "!" at the end of its name tag (by its head when it has no
//     tag, in the banner for an orchestrator): no flash, no hop.
//   white + a shape = selected: brackets round the name plate (or banner), a ring on the floor, a white outline
//     and a big hopping arrow that is placed where it covers no pod sign, banner or other tag.
//   thick white outline + a tooltip (task name in the big font, project · activity) = the pointer is on it;
//     its name tag is outlined white too. Red = a helper that failed. Tool colours and group colours are
//     never used for any of the above, and nothing in the scenery is bright yellow or signal red.
// Depth: people are drawn in order of their feet; someone walking is sorted a few px further back, so a walker
// whose lane runs just in front of seated or standing people passes behind them, never across them.
// A character is only ever shown waiting / seated once it has ARRIVED: on the way it is a walker with a compact
// badge (tool badge + small name; the badge alone where the name would lie over a face, a desk plate or a
// table; nothing over a zone sign), and the card on its desk says ARRIVING.
//
// Time: the simulation runs on real elapsed time (performance.now()), in fixed slices, whoever triggers a
// frame. Up to 2.5 s between two frames are caught up exactly; after a longer gap (throttled pane, hidden tab,
// sleep) everyone is put where they belong before the first frame is drawn. A page that reports itself hidden
// never shows a walk: it repaints on news and on a 1.5 s heartbeat, always settled.
//
// Painting: the office is drawn synchronously on the first state and after every canvas resize, so it never
// depends on requestAnimationFrame being delivered (a tab loading in the background). A watchdog timer keeps a
// visible-but-throttled page repainting a few times a second, and whenever one of the methods above changes
// what is shown it is repainted soon after.
export { createOffice } from './office.js';
export { drawPortrait } from './sprites.js';
