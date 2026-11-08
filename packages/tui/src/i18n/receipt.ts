import type { MessageKey, MessageParams } from "./index"

export type DagModeReceiptKind = "on" | "off" | "status" | "budget"

/**
 * `metadata.receipt` carried by the `/dag-mode` command's ignored part. The
 * producer also writes a fallback text; this renderer is the TUI-side version
 * that can insert the currently bound keymap key.
 */
export interface DagModeReceipt {
  kind: DagModeReceiptKind
  values?: Record<string, string | number | boolean | undefined>
}

export interface DagModeReceiptContext {
  /** The keymap binding for `session.dagmode.toggle`, e.g. `<leader>d`. */
  key: string
}

type Translate = (key: MessageKey, params?: MessageParams) => string

function value(values: Record<string, string | number | boolean | undefined>, name: string) {
  const found = values[name]
  if (found === undefined || found === null || found === "") return "—"
  return String(found)
}

/**
 * Render a DAG mode receipt. Reads through `t`, so a language switch re-renders
 * historical receipts as long as the caller renders inside a reactive scope.
 */
export function renderDagModeReceipt(receipt: DagModeReceipt, t: Translate, ctx: DagModeReceiptContext): string {
  const values = receipt.values ?? {}
  switch (receipt.kind) {
    case "on": {
      const parts = [
        t("dagmode.receipt.on", {
          cap: value(values, "cap"),
          nodes: value(values, "nodes"),
          budget: value(values, "budget"),
          key: ctx.key,
        }),
      ]
      if (values.noBudget) parts.push(t("dagmode.receipt.on.noBudget"))
      if (values.unavailable) parts.push(t("dagmode.receipt.on.unavailable", { reason: String(values.unavailable) }))
      return parts.join(" ")
    }
    case "off":
      return t("dagmode.receipt.off", { n: value(values, "n") })
    case "status":
      return t("dagmode.receipt.status", {
        state: value(values, "state"),
        default: value(values, "default"),
        running: value(values, "running"),
        cap: value(values, "cap"),
        nodes: value(values, "nodes"),
        used: value(values, "used"),
        budget: value(values, "budget"),
      })
    case "budget":
      return t("dagmode.receipt.budget", { N: value(values, "N"), k: value(values, "k") })
  }
}
