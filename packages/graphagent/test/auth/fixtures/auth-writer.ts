import { Effect } from "effect"
import { Auth } from "../../../src/auth"

await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    for (let i = 0; i < 8; i++) {
      yield* auth.set(`fixture-${process.argv[2]}-${i}`, { type: "api", key: "synthetic" })
    }
  }).pipe(Effect.provide(Auth.defaultLayer)),
)
