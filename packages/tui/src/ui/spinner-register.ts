import { extend } from "@opentui/solid"
import { SpinnerRenderable } from "./spinner-renderable"

// Explicit registration is load-bearing. `bun build` on a Windows host drops
// side-effect-only component imports, so `<spinner>` crashed with
// "[Reconciler] Unknown component type: spinner" on Windows. The explicit
// extend() below survives tree-shaking and fixes it. JSX typing for
// `<spinner>` comes from the module augmentation in `spinner-renderable`.
extend({ spinner: SpinnerRenderable })
