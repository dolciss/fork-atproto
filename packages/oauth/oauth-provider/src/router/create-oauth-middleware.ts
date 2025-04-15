import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  oauthAuthorizationRequestParSchema,
  oauthClientCredentialsSchema,
  oauthTokenIdentificationSchema,
  oauthTokenRequestSchema,
} from '@atproto/oauth-types'
import { buildErrorPayload, buildErrorStatus } from '../errors/error-parser.js'
import { InvalidClientError } from '../errors/invalid-client-error.js'
import { InvalidGrantError } from '../errors/invalid-grant-error.js'
import { InvalidRequestError } from '../errors/invalid-request-error.js'
import { WWWAuthenticateError } from '../errors/www-authenticate-error.js'
import {
  Middleware,
  Router,
  cacheControlMiddleware,
  combineMiddlewares,
  jsonHandler,
  parseHttpRequest,
  staticJsonMiddleware,
} from '../lib/http/index.js'
import { extractZodErrorMessage } from '../lib/util/zod-error.js'
import type { OAuthProvider } from '../oauth-provider.js'
import type { MiddlewareOptions } from './middleware-options.js'

// CORS preflight
const corsHeaders: Middleware = function (req, res, next) {
  res.setHeader('Access-Control-Max-Age', '86400') // 1 day

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
  //
  // > For requests without credentials, the literal value "*" can be
  // > specified as a wildcard; the value tells browsers to allow
  // > requesting code from any origin to access the resource.
  // > Attempting to use the wildcard with credentials results in an
  // > error.
  //
  // A "*" is safer to use than reflecting the request origin.
  res.setHeader('Access-Control-Allow-Origin', '*')

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Methods
  // > The value "*" only counts as a special wildcard value for
  // > requests without credentials (requests without HTTP cookies or
  // > HTTP authentication information). In requests with credentials,
  // > it is treated as the literal method name "*" without special
  // > semantics.
  res.setHeader('Access-Control-Allow-Methods', '*')

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,DPoP')

  next()
}

const corsPreflight: Middleware = combineMiddlewares([
  corsHeaders,
  (req, res) => {
    res.writeHead(200).end()
  },
])

export function createOAuthMiddleware<
  Ctx extends object | void = void,
  Req extends IncomingMessage = IncomingMessage,
  Res extends ServerResponse = ServerResponse,
>(
  server: OAuthProvider,
  { onError }: MiddlewareOptions<Req, Res>,
): Middleware<Ctx, Req, Res> {
  const router = new Router<Ctx, Req, Res>(new URL(server.issuer))

  //- Public OAuth endpoints

  router.options('/.well-known/oauth-authorization-server', corsPreflight)
  router.get(
    '/.well-known/oauth-authorization-server',
    corsHeaders,
    cacheControlMiddleware(300),
    staticJsonMiddleware(server.metadata),
  )

  router.options('/oauth/jwks', corsPreflight)
  router.get(
    '/oauth/jwks',
    corsHeaders,
    cacheControlMiddleware(300),
    staticJsonMiddleware(server.jwks),
  )

  router.options('/oauth/par', corsPreflight)
  router.post(
    '/oauth/par',
    corsHeaders,
    oauthHandler(async function (req) {
      const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

      const credentials = await oauthClientCredentialsSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidRequest)

      const authorizationRequest = await oauthAuthorizationRequestParSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidRequest)

      const dpopJkt = await server.checkDpopProof(
        req.headers['dpop'],
        req.method!,
        this.url,
      )

      return server.pushedAuthorizationRequest(
        credentials,
        authorizationRequest,
        dpopJkt,
      )
    }, 201),
  )
  // https://datatracker.ietf.org/doc/html/rfc9126#section-2.3
  // > If the request did not use the POST method, the authorization server
  // > responds with an HTTP 405 (Method Not Allowed) status code.
  router.all('/oauth/par', (req, res) => {
    res.writeHead(405).end()
  })

  router.options('/oauth/token', corsPreflight)
  router.post(
    '/oauth/token',
    corsHeaders,
    oauthHandler(async function (req) {
      const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

      const clientMetadata = await server.deviceManager.getRequestMetadata(req)

      const clientCredentials = await oauthClientCredentialsSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidClient)

      const tokenRequest = await oauthTokenRequestSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidGrant)

      const dpopJkt = await server.checkDpopProof(
        req.headers['dpop'],
        req.method!,
        this.url,
      )

      return server.token(
        clientCredentials,
        clientMetadata,
        tokenRequest,
        dpopJkt,
      )
    }),
  )

  router.options('/oauth/revoke', corsPreflight)
  router.post(
    '/oauth/revoke',
    corsHeaders,
    oauthHandler(async function (req, res) {
      const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

      const credentials = await oauthClientCredentialsSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidRequest)

      const tokenIdentification = await oauthTokenIdentificationSchema
        .parseAsync(payload, { path: ['body'] })
        .catch(throwInvalidRequest)

      try {
        await server.revoke(credentials, tokenIdentification)
      } catch (err) {
        // > Note: invalid tokens do not cause an error response since the
        // > client cannot handle such an error in a reasonable way.  Moreover,
        // > the purpose of the revocation request, invalidating the particular
        // > token, is already achieved.
        //
        // https://datatracker.ietf.org/doc/html/rfc7009#section-2.2

        onError?.(req, res, err, 'Failed to revoke token')
      }

      return {}
    }),
  )

  return router.buildMiddleware()

  function oauthHandler<T>(
    buildOAuthResponse: (this: T, req: Req, res: Res) => unknown,
    status?: number,
  ): Middleware<T, Req, Res> {
    return jsonHandler<T, Req, Res>(async function (req, res) {
      try {
        // https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Pragma', 'no-cache')

        // https://datatracker.ietf.org/doc/html/rfc9449#section-8.2
        const dpopNonce = server.nextDpopNonce()
        if (dpopNonce) {
          const name = 'DPoP-Nonce'
          res.setHeader(name, dpopNonce)
          res.appendHeader('Access-Control-Expose-Headers', name)
        }

        const payload = await buildOAuthResponse.call(this, req, res)
        return { payload, status }
      } catch (err) {
        onError?.(req, res, err, 'OAuth request error')

        if (!res.headersSent && err instanceof WWWAuthenticateError) {
          const name = 'WWW-Authenticate'
          res.setHeader(name, err.wwwAuthenticateHeader)
          res.appendHeader('Access-Control-Expose-Headers', name)
        }

        const status = buildErrorStatus(err)
        const payload = buildErrorPayload(err)

        return { payload, status }
      }
    })
  }
}

function throwInvalidGrant(err: unknown): never {
  throw new InvalidGrantError(
    extractZodErrorMessage(err) ?? 'Invalid grant',
    err,
  )
}

function throwInvalidClient(err: unknown): never {
  throw new InvalidClientError(
    extractZodErrorMessage(err) ?? 'Client authentication failed',
    err,
  )
}

function throwInvalidRequest(err: unknown): never {
  throw new InvalidRequestError(
    extractZodErrorMessage(err) ?? 'Input validation error',
    err,
  )
}
