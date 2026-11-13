import { Schema } from "effect"

export class InvalidRequestError extends Schema.Error<InvalidRequestError>("InvalidRequestError")(
  {
    name: Schema.Literal("InvalidRequestError"),
    data: Schema.Struct({
      message: Schema.String,
      kind: Schema.optional(Schema.String),
      field: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.Error<UnauthorizedError>("UnauthorizedError")(
  {
    name: Schema.Literal("UnauthorizedError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 401 },
) {}

export class ForbiddenError extends Schema.Error<ForbiddenError>("ForbiddenError")(
  {
    name: Schema.Literal("ForbiddenError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 403 },
) {}

export class ConflictError extends Schema.Error<ConflictError>("ConflictError")(
  {
    name: Schema.Literal("ConflictError"),
    data: Schema.Struct({
      message: Schema.String,
      resource: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 409 },
) {}

export class UpstreamError extends Schema.Error<UpstreamError>("UpstreamError")(
  {
    name: Schema.Literal("UpstreamError"),
    data: Schema.Struct({
      message: Schema.String,
      service: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Number),
    }),
  },
  { httpApiStatus: 502 },
) {}

export class ServiceUnavailableError extends Schema.Error<ServiceUnavailableError>("ServiceUnavailableError")(
  {
    name: Schema.Literal("ServiceUnavailableError"),
    data: Schema.Struct({
      message: Schema.String,
      service: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 503 },
) {}

export class TimeoutError extends Schema.Error<TimeoutError>("TimeoutError")(
  {
    name: Schema.Literal("TimeoutError"),
    data: Schema.Struct({
      message: Schema.String,
      operation: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 504 },
) {}

export class UnknownError extends Schema.Error<UnknownError>("UnknownError")(
  {
    name: Schema.Literal("UnknownError"),
    data: Schema.Struct({
      message: Schema.String,
      ref: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 500 },
) {}

export class ProviderNotFoundError extends Schema.Error<ProviderNotFoundError>("ProviderNotFoundError")(
  {
    name: Schema.Literal("ProviderNotFoundError"),
    data: Schema.Struct({
      providerID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class ModelNotFoundError extends Schema.Error<ModelNotFoundError>("ModelNotFoundError")(
  {
    name: Schema.Literal("ModelNotFoundError"),
    data: Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      suggestions: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class SessionNotFoundError extends Schema.Error<SessionNotFoundError>("SessionNotFoundError")(
  {
    name: Schema.Literal("SessionNotFoundError"),
    data: Schema.Struct({
      sessionID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class MessageNotFoundError extends Schema.Error<MessageNotFoundError>("MessageNotFoundError")(
  {
    name: Schema.Literal("MessageNotFoundError"),
    data: Schema.Struct({
      sessionID: Schema.String,
      messageID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class InvalidCursorError extends Schema.Error<InvalidCursorError>("InvalidCursorError")(
  {
    name: Schema.Literal("InvalidCursorError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export class SessionBusyError extends Schema.Error<SessionBusyError>("SessionBusyError")(
  {
    name: Schema.Literal("SessionBusyError"),
    data: Schema.Struct({
      sessionID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

// #1026: a child session (parentID != null) only takes input from its parent
// agent, so a write that addresses one over HTTP is refused. Same
// `{name, data:{sessionID, message}}` envelope as SessionBusyError; clients
// branch on `name`, there is no separate `code` field.
export class ChildSessionReadOnlyError extends Schema.Error<ChildSessionReadOnlyError>("ChildSessionReadOnlyError")(
  {
    name: Schema.Literal("ChildSessionReadOnlyError"),
    data: Schema.Struct({
      sessionID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export class BtwBusyError extends Schema.Error<BtwBusyError>("BtwBusyError")(
  {
    name: Schema.Literal("BtwBusy"),
    data: Schema.Struct({
      sessionID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export class BtwCancelledError extends Schema.Error<BtwCancelledError>("BtwCancelledError")(
  {
    name: Schema.Literal("BtwCancelled"),
    data: Schema.Struct({
      sessionID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export class BtwTimeoutError extends Schema.Error<BtwTimeoutError>("BtwTimeoutError")(
  {
    name: Schema.Literal("BtwTimeout"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 504 },
) {}

export class QuestionNotFoundError extends Schema.Error<QuestionNotFoundError>("QuestionNotFoundError")(
  {
    name: Schema.Literal("QuestionNotFoundError"),
    data: Schema.Struct({
      requestID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class PermissionNotFoundError extends Schema.Error<PermissionNotFoundError>("PermissionNotFoundError")(
  {
    name: Schema.Literal("PermissionNotFoundError"),
    data: Schema.Struct({
      requestID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class McpServerNotFoundError extends Schema.Error<McpServerNotFoundError>("McpServerNotFoundError")(
  {
    name: Schema.Literal("McpServerNotFoundError"),
    data: Schema.Struct({
      name: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class PtyNotFoundError extends Schema.Error<PtyNotFoundError>("PtyNotFoundError")(
  {
    name: Schema.Literal("PtyNotFoundError"),
    data: Schema.Struct({
      ptyID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class PtyForbiddenError extends Schema.Error<PtyForbiddenError>("PtyForbiddenError")(
  {
    name: Schema.Literal("PtyForbiddenError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

export class ProjectNotFoundError extends Schema.Error<ProjectNotFoundError>("ProjectNotFoundError")(
  {
    name: Schema.Literal("ProjectNotFoundError"),
    data: Schema.Struct({
      projectID: Schema.String,
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export class ProjectCopyError extends Schema.Error<ProjectCopyError>("ProjectCopyError")(
  {
    name: Schema.Literal("ProjectCopyError"),
    data: Schema.Struct({
      message: Schema.String,
      forceRequired: Schema.optional(Schema.Boolean),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiNotFoundError extends Schema.Error<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}
