# `src/validate/standin/` — temporary lane stand-ins

L11 was written in parallel with the lanes it depends on. `API.md` declares the
surfaces; the modules behind some of them had not landed when this lane started.

Each file here implements one declared cross-lane surface exactly as `API.md`
describes it, so L11's own code and tests could run before the owning lane
landed. Nothing here is a second implementation of anything: the bridge modules
one directory up (`lane-brand.js`, `lane-scene.js`, `lane-branch.js`,
`lane-emit.js`) are single-line re-exports, and flipping one from a stand-in to
the real module is a one-line edit.

**The end state is that this directory is empty and every bridge points at the
owning lane.** Any file remaining here is a lane that had not landed when L11
finished, and it is named as such in `docs/decisions/L11-validate.md`.
