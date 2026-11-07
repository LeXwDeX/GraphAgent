import { extend } from "@opentui/solid"
import { SpinnerRenderable } from "opentui-spinner"
import "opentui-spinner/solid"

// Explicit registration is load-bearing. `bun build` on a Windows host drops
// the side-effect-only `opentui-spinner/solid` import (its package.json
// `sideEffects` path glob does not match backslash paths), so `<spinner>`
// crashed with "[Reconciler] Unknown component type: spinner" on Windows.
// The explicit extend() below survives tree-shaking and fixes it.
//
// The retained side-effect import is NOT redundant: it provides JSX type
// augmentation for `<spinner>` in the Solid JSX runtime. At runtime it also
// re-registers, but extend() is Object.assign over a flat catalogue, so the
// duplicate registration is harmless.
extend({ spinner: SpinnerRenderable })
