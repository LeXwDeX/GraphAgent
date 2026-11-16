// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { Match, Switch, type ParentProps } from "solid-js"
import { useRoute } from "../../src/context/route"
import { Home } from "../../src/routes/home"
import { Main } from "../../src/routes/session"
import { AppFrame } from "../../src/shell/app-frame"
import {
  BottomZone,
  BottomZoneProvider,
  createBottomZoneState,
  type BottomZoneStateApi,
} from "../../src/shell/bottom-zone"

/**
 * The part of the app shell that hosts a route's input: the frame with its bottom zone around the view under test,
 * wired as `app.tsx` wires it. A route installs its prompt in the zone's composer slot instead of drawing it in its
 * own column (#1032 D1), so a route view mounted without a zone has no prompt at all. Mount it inside the provider
 * stack the route needs.
 */
export function RouteFrame(props: ParentProps<{ onZone?: (zone: BottomZoneStateApi) => void }>) {
  const zone = createBottomZoneState()
  props.onZone?.(zone)
  return (
    <BottomZoneProvider state={zone}>
      <AppFrame dimmed={zone.dimmed} bottomZone={<BottomZone state={zone} />}>
        {props.children}
      </AppFrame>
    </BottomZoneProvider>
  )
}

/**
 * Only the bottom zone, stacked under the view with nothing around it: no top bar, no footer. A view whose frame is
 * snapshotted keeps the rows it had before its prompt moved into the zone, and the snapshot shows the prompt at the
 * same place.
 */
export function RouteZone(props: ParentProps<{ onZone?: (zone: BottomZoneStateApi) => void }>) {
  const zone = createBottomZoneState()
  props.onZone?.(zone)
  return (
    <BottomZoneProvider state={zone}>
      {props.children}
      <BottomZone state={zone} />
    </BottomZoneProvider>
  )
}

/** The route switch of `app.tsx` without the diff route: the home view, or the session of the current route. */
export function AppRoutes() {
  const route = useRoute()
  return (
    <Switch>
      <Match when={route.data.type === "home"}>
        <Home />
      </Match>
      <Match when={route.data.type === "session"}>
        <Main />
      </Match>
    </Switch>
  )
}
