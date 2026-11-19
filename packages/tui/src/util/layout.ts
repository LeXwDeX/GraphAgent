import type { BaseRenderable, BoxRenderable } from "@opentui/core"

/**
 * Boxes that the row after them always keeps a blank line from, whatever height they have when the margin is taken: the
 * margin of `setPreLayoutSiblingMargin` is read before the layout, when a box that has just mounted has no height yet.
 */
export const alwaysSeparate = new WeakSet<BoxRenderable>()

const previousByParent = new WeakMap<
  BaseRenderable,
  { frameID: number; previous: WeakMap<BaseRenderable, BaseRenderable | undefined> }
>()

export function setPreLayoutSiblingMargin(el: BoxRenderable, margin: (previous?: BaseRenderable) => number) {
  // Run before Yoga layout so scroll geometry matches the rendered frame.
  el.onLifecyclePass = () => {
    const parent = el.parent
    if (!parent) return
    const cached = previousByParent.get(parent)
    const previous = cached?.frameID === el.ctx.frameId ? cached.previous : previousSiblings(parent, el.ctx.frameId)
    const value = margin(previous.get(el))
    if (el.marginTop !== value) el.marginTop = value
  }
}

function previousSiblings(parent: BaseRenderable, frameID: number) {
  const previous = new WeakMap<BaseRenderable, BaseRenderable | undefined>()
  parent.getChildren().forEach((child, index, children) => previous.set(child, children[index - 1]))
  previousByParent.set(parent, { frameID, previous })
  return previous
}
