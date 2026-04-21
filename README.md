# 刻 · hours

A pomodoro timer reimagined as a golden hour in the sand. Shape the dunes,
light the gates, let the hours walk.

Pour sand to form a path, press begin, and a cloaked traveler (with a fox
companion) walks the terrain you drew over the focus duration. Four focus
sessions make one journey; after the final long rest you earn a "new
journey" screen and can start over.

Cumulative focus time is tracked in miles ("1 minute focus = 1 mile") and
persists across tabs and refreshes via `localStorage`.

## Running

No build step — open `index.html` in any modern browser:

```
open index.html       # macOS
xdg-open index.html   # Linux
start index.html      # Windows
```

Or serve over a simple HTTP server if your browser restricts local files:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Structure

```
.
├── index.html   # markup + SVG scene
├── styles.css   # theme, animation, layout
├── app.js       # timer, sand physics, traveler, audio
└── bgm.mp3      # (user-supplied) optional background music
```

## Background music

`bgm.mp3` is a ~4-hour ambient loop included in the repo. The `bgm`
slider in the tweaks panel (top-right hamburger) controls its volume:
0 = paused, >0 = playing at that volume. When a focus / rest phase
ends the chime temporarily ducks the BGM, then resumes it.

To swap in your own track, replace `bgm.mp3` with any audio file of
the same name (MP3 recommended for broadest browser support).

## Controls

| Where | What |
| --- | --- |
| Canvas | Click-drag to pour sand until the reservoir is empty |
| `begin` | Start the focus session (disabled until sand is fully poured) |
| `pause` (under timer) | Freeze the countdown |
| `reset` (bottom-right) | Clear session state, keep accumulated miles |
| Hamburger (top-right) | Toggle the tweaks panel (focus/short/long/speed/bgm) |

## License

MIT — see `LICENSE`.
