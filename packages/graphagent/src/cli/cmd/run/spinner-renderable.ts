// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import {
  parseColor,
  resolveRenderLib,
  Renderable,
  RGBA,
  type ColorInput,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import spinners from "cli-spinners"

/**
 * OpenTUI 0.8 removed the render-lib `encodeUnicode` API that the previous
 * spinner package encodes its frames with, and that package has no release for
 * 0.8. This is a thin local replacement that keeps the `<spinner>` element, its
 * props, and its frame/color behaviour.
 *
 * Frames are measured and drawn through the renderer's `OptimizedBuffer`, so
 * the spinner follows the active width method without owning native
 * resources of its own.
 */
export type ColorGenerator = (
  frameIndex: number,
  charIndex: number,
  totalFrames: number,
  totalChars: number,
) => ColorInput

export type SpinnerName = keyof typeof spinners

export type SpinnerOptions = RenderableOptions & {
  name?: SpinnerName
  frames?: string[]
  interval?: number
  autoplay?: boolean
  backgroundColor?: ColorInput
  color?: ColorInput | ColorGenerator
}

const MIN_INTERVAL = 1000 / 60
const MAX_INTERVAL = 1000
const segmenter = new Intl.Segmenter()
const lib = resolveRenderLib()
const encoder = new TextEncoder()

const segment = (text: string) => Array.from(segmenter.segment(text), (entry) => entry.segment)

function measure(text: string, widthMethod: RenderContext["widthMethod"]) {
  return lib.editMeasureText(encoder.encode(text), widthMethod, 0)
}

function clampInterval(value: number) {
  if (!Number.isFinite(value) || value < MIN_INTERVAL || value > MAX_INTERVAL) {
    throw new RangeError(`Spinner interval must be a finite number between ${MIN_INTERVAL}ms and ${MAX_INTERVAL}ms`)
  }
  return value
}

const DEFAULT_FRAMES = spinners.dots.frames

export class SpinnerRenderable extends Renderable {
  private _name: SpinnerName | undefined
  private _frames: string[]
  private _interval: number
  private _autoplay: boolean
  private _backgroundColor: ColorInput
  private _parsedBackgroundColor: RGBA
  private _color: ColorInput | ColorGenerator
  private _parsedColor: RGBA
  private _currentFrameIndex = 0
  private _timer: ReturnType<typeof setInterval> | undefined
  private _running = false

  constructor(ctx: RenderContext, options: SpinnerOptions) {
    super(ctx, { ...options, height: 1 })
    this._name = options.name
    this._frames = options.frames?.length ? options.frames : this._name ? spinners[this._name].frames : DEFAULT_FRAMES
    this._interval = clampInterval(
      options.interval ?? (this._name ? spinners[this._name].interval : spinners.dots.interval),
    )
    this._autoplay = options.autoplay ?? true
    this._backgroundColor = options.backgroundColor ?? "transparent"
    this._parsedBackgroundColor = parseColor(this._backgroundColor)
    this._color = options.color ?? "white"
    this._parsedColor = typeof this._color === "function" ? parseColor("white") : parseColor(this._color)
    this.width = this._frameWidth()
    if (this._autoplay) this.start()
  }

  private _frameWidth() {
    if (this._frames.length === 0) return 0
    return Math.max(...this._frames.map((frame) => measure(frame, this.ctx.widthMethod)))
  }

  private _advance() {
    this._currentFrameIndex = (this._currentFrameIndex + 1) % this._frames.length
    this.requestRender()
  }

  private _arm() {
    if (this._timer) return
    const timer = setInterval(() => this._advance(), this._interval)
    timer.unref()
    this._timer = timer
  }

  private _disarm() {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = undefined
  }

  get interval() {
    return this._interval
  }

  set interval(value: number) {
    this._interval = clampInterval(value)
    if (this._running && this.visible) {
      this._disarm()
      this._arm()
    }
  }

  get name() {
    return this._name
  }

  set name(value: SpinnerName | undefined) {
    this._name = value
    const frames = value ? spinners[value].frames : DEFAULT_FRAMES
    const interval = clampInterval(value ? spinners[value].interval : spinners.dots.interval)
    const changed = this._frames !== frames
    const retimed = this._interval !== interval
    this._interval = interval
    if (changed) {
      this._frames = frames
      this._currentFrameIndex = 0
      this.width = this._frameWidth()
      if (this.visible) this.requestRender()
    }
    if (this._running && retimed && this.visible) {
      this._disarm()
      this._arm()
    }
  }

  get frames() {
    return this._frames
  }

  set frames(value: string[]) {
    const frames = value.length === 0 ? DEFAULT_FRAMES : value
    if (frames === this._frames) return
    this._frames = frames
    this._currentFrameIndex = 0
    this.width = this._frameWidth()
    if (this.visible) this.requestRender()
  }

  get color() {
    return this._color
  }

  set color(value: ColorInput | ColorGenerator) {
    this._color = value
    if (typeof value !== "function") this._parsedColor = parseColor(value)
    if (this.visible) this.requestRender()
  }

  get backgroundColor() {
    return this._backgroundColor
  }

  set backgroundColor(value: ColorInput) {
    this._backgroundColor = value
    this._parsedBackgroundColor = parseColor(value)
    if (this.visible) this.requestRender()
  }

  override get visible() {
    return super.visible
  }

  override set visible(value: boolean) {
    if (value === super.visible) return
    super.visible = value
    if (this._running) {
      if (value) this._arm()
      else this._disarm()
    }
  }

  get autoplay() {
    return this._autoplay
  }

  set autoplay(value: boolean) {
    this._autoplay = value
    if (value) this.start()
    else this.stop()
  }

  start() {
    if (this._running || this.isDestroyed) return
    this._running = true
    if (this.visible) this._arm()
  }

  stop() {
    if (!this._running) return
    this._running = false
    this._disarm()
  }

  protected override destroySelf() {
    this.stop()
    super.destroySelf()
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    if (!this.visible) return
    const frame = this._frames[this._currentFrameIndex]
    if (!frame) return
    const chars = segment(frame)
    let x = this.x
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index]
      const fg =
        typeof this._color === "function"
          ? parseColor(this._color(this._currentFrameIndex, index, this._frames.length, chars.length))
          : this._parsedColor
      buffer.drawText(char, x, this.y, fg, this._parsedBackgroundColor)
      x += measure(char, this.ctx.widthMethod)
    }
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    spinner: typeof SpinnerRenderable
  }
}
