import type { Payload as EventPayload } from "@graphagent/core/event"
import type { Auth } from "@/auth"
import type { Project } from "@/project/project"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { SessionV1 } from "@graphagent/core/v1/session"

export type ProviderContext = Provider.Info

export type AuthOAuthResult = { url: string; instructions: string } &
  (
    | {
        method: "auto"
        callback(): Promise<
          | ({ type: "success"; provider?: string } &
              (
                | {
                    refresh: string
                    access: string
                    expires: number
                    accountId?: string
                    enterpriseUrl?: string
                  }
                | { key: string; metadata?: Record<string, string> }
              ))
          | { type: "failed" }
        >
      }
    | {
        method: "code"
        callback(code: string): Promise<
          | ({ type: "success"; provider?: string } &
              (
                | {
                    refresh: string
                    access: string
                    expires: number
                    accountId?: string
                    enterpriseUrl?: string
                  }
                | { key: string; metadata?: Record<string, string> }
              ))
          | { type: "failed" }
        >
      }
  )

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth.Info>, provider: Provider.Info) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{ label: string; value: string; hint?: string }>
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{ label: string; value: string; hint?: string }>
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | { type: "success"; key: string; provider?: string; metadata?: Record<string, string> }
          | { type: "failed" }
        >
      }
  )[]
}

export type AdapterContext = {
  readonly directory: string
  readonly worktree: string
  readonly project: Project.Info
  readonly auth: { set(providerID: string, info: Auth.Info): Promise<void> }
  readonly sessions: {
    get(sessionID: string): Promise<Session.Info | undefined>
    message(sessionID: string, messageID: string): Promise<{ parts: SessionV1.Part[] } | undefined>
  }
  readonly experimentalWebSockets: boolean
}

export type ChatInput = {
  sessionID: string
  agent: string
  model: Provider.Model
  provider: ProviderContext
  message: SessionV1.User
}

export type ChatParams = {
  temperature: number | undefined
  topP: number | undefined
  topK: number | undefined
  maxOutputTokens: number | undefined
  options: Record<string, any>
}

export interface ProviderAdapter {
  readonly id: string
  readonly auth?: AuthHook
  readonly provider?: {
    readonly id: string
    readonly models?: (provider: Provider.Info, ctx: { auth?: Auth.Info }) => Promise<Record<string, Provider.Model>>
  }
  readonly smallModel?: (input: { provider: Provider.Info }) => Provider.Model | undefined
  readonly chatParams?: (input: ChatInput, output: ChatParams) => Promise<void> | void
  readonly chatHeaders?: (input: ChatInput, output: { headers: Record<string, string> }) => Promise<void> | void
  readonly onEvent?: (event: { id: string; type: string; properties: unknown }) => Promise<void> | void
  readonly dispose?: () => Promise<void> | void
}

export type ProviderAdapterFactory = (ctx: AdapterContext) => ProviderAdapter | Promise<ProviderAdapter>

export type AdapterEvent = EventPayload

export * as ProviderAdapter from "./types"
