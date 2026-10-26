# Demo video & README media

The demo video and the README images are plain HTML pages rendered frame by frame with
Playwright (headless Chromium) and encoded with ffmpeg, the same technique as
[HyperFrames](https://hyperframes.heygen.com/). Every frame is a pure function of time
(`render(t)` in `composition.html`), so renders are smooth and reproducible.

| File | What it is |
|---|---|
| `composition.html` | the 46 s launch video (1920×1080) |
| `media.html` | README boards: hero / social preview, framed screenshots, themes, phones, architecture |
| `render.py` | renders the video: `python3 render.py . 60 out/ankibase-demo.mp4` |
| `frames.py` | stills for checking timing: `python3 frames.py . 2.5,8,14 prev` |
| `media.py` | renders every board to WebP in `media/` |
| `fonts/` | Inter, Instrument Serif and JetBrains Mono (SIL OFL) |

Both pages read app screenshots from `shots/` (git-ignored), taken from a demo instance at
1280×800 @2x (desktop) and 390×844 @3x (phone): `study-q`, `study`, `quizlet-learn`, `quizlet-match`,
`story`, `reading-plain`, `reading`, `stats` (full page), `decks`, `search`, `settings`, `study-hub`,
`theme-study-<theme>`, `theme-decks-<theme>`, `m-study`, `m-reading`, `m-learn`.

Requirements: Python 3 with `playwright` (+ `playwright install chromium`), Pillow, and ffmpeg.
Copy the results to `docs/public/media/`.
