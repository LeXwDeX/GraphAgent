import { HttpApiMiddleware } from "effect/http-api"
import { InvalidRequestError } from "../errors"

export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@graphagent/HttpApiSchemaError",
  { error: InvalidRequestError },
) {}
