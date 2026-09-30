> Open item 42 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 42. Alpha fusion replaces the numbers every directional gate reads

Not a defect — the blast radius, recorded so it is not rediscovered.

`applyAlphaFusion` does not annotate the analysis; it overwrites `direction`,
`confidence`, `score` and `edge` (`alphaFusion.ts:163-177`). Every downstream
entry gate, Kelly size and governor input therefore changes the moment fusion is
wired in, and `getSignalForBoth` calls it unconditionally in the fork.

Mitigated with a kill switch rather than a flag day: `cfg.useAlphaFusion === false`
turns it off from config with no redeploy. It defaults **on**, because that is
what steps 3–4 were asked to deliver. The switch rides on the fusion context
because that is the only channel `signal.ts` already reads — adding a config
import there would have created a cycle.

Watch paper trading for a shift in entry rate and average confidence before this
reaches live. That comparison is the point of keeping paper running.
