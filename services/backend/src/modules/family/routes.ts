import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as schemas from '@probyu/contracts/schemas';
import type {
  FamilyCommand,
  FamilyLoginRequest,
  FamilyProofRequest,
  FamilyReauthRequest,
} from '@probyu/contracts/types';
import { AccessError, equalDigest } from './policy.js';
import type { FamilyService } from './service.js';
import { ingressIp } from './ingress.js';

const COOKIE = '__Host-probuyu_session';
function schema(name: string): Record<string, unknown> {
  const value = (schemas as Record<string, unknown>)[`${name}Schema`];
  if (!value) throw new Error(`Missing contract ${name}`);
  function resolve(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$ref === 'string') return schema(o.$ref.split('/').at(-1)!);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  }
  return resolve(value) as Record<string, unknown>;
}
function cookie(request: FastifyRequest) {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
const cookieHeader = (token: string) =>
  `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`;
export function registerFamilyRoutes(app: FastifyInstance, service: FamilyService) {
  // Encapsulation keeps the public fixed demo free of cookies and private middleware.
  void app.register((privateApp, _options, done) => {
    privateApp.addHook('onRequest', (request, reply, done) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      // Configured proxy mode has no direct-request fallback or alternate rate bucket.
      ingressIp(request, service.config.proxyKey);
      if (request.method === 'POST') {
        if (
          request.headers.origin !== service.config.origin ||
          request.headers['sec-fetch-site'] === 'cross-site'
        )
          throw new AccessError('FORBIDDEN');
        if (request.url === '/v1/family/bootstrap') {
          if (request.headers['x-probyu-bootstrap'] !== '1') throw new AccessError('FORBIDDEN');
        } else {
          const token = cookie(request);
          if (!token) throw new AccessError('UNAUTHENTICATED', 401);
          if (!equalDigest(request.headers['x-csrf-token'], service.csrf(token)))
            throw new AccessError('FORBIDDEN');
        }
      }
      done();
    });
    privateApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccessError) {
        if (error.code === 'RATE_LIMITED') reply.header('Retry-After', '900');
        void reply.code(error.status).send({
          code: error.code,
          ...(error.remainingAttempts !== undefined
            ? { remainingAttempts: error.remainingAttempts }
            : {}),
          ...(error.code === 'RATE_LIMITED' ? { retryAfterSeconds: 900 } : {}),
        });
        return;
      }
      if (
        (error as { validation?: unknown }).validation ||
        [400, 413, 415].includes((error as { statusCode?: number }).statusCode ?? 0)
      ) {
        void reply.code(400).send({ code: 'INVALID_REQUEST' });
        return;
      }
      // No SQL, body, cookie, identity or credential can enter error telemetry.
      app.log.warn('family operation unavailable');
      void reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    const route = (
      path: string,
      method: 'GET' | 'POST',
      response: string,
      body: string | undefined,
      handler: (request: FastifyRequest, token: string) => unknown,
    ) => {
      privateApp.route({
        url: `/v1/family/${path}`,
        method,
        bodyLimit: 4096,
        schema: {
          ...(body ? { body: schema(body) } : {}),
          response: {
            200: schema(response),
            400: schema('FamilyError'),
            401: schema('FamilyError'),
            403: schema('FamilyError'),
            409: schema('FamilyError'),
            429: schema('FamilyError'),
            503: schema('FamilyError'),
          },
        },
        handler: async (request, reply) => {
          const token = cookie(request);
          if (path === 'bootstrap') {
            await service.ingressBudget(
              'bootstrap-ip',
              ingressIp(request, service.config.proxyKey),
              120,
            );
            const r = await service.bootstrap(token);
            reply.header('Set-Cookie', cookieHeader(r.token));
            return r.view;
          }
          if (!token) throw new AccessError('UNAUTHENTICATED', 401);
          const result = await handler(request, token);
          if (
            result &&
            typeof result === 'object' &&
            'token' in result &&
            typeof result.token === 'string'
          ) {
            reply.header('Set-Cookie', cookieHeader(result.token));
            if (path === 'login') return service.view(result.token);
          }
          if (path === 'logout')
            reply.header(
              'Set-Cookie',
              `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
            );
          return result;
        },
      });
    };
    route('bootstrap', 'POST', 'FamilySession', undefined, () => null);
    route('session', 'GET', 'FamilySession', undefined, (_r, t) => service.view(t));
    route('documents', 'GET', 'FamilyDocuments', undefined, async (_r, t) => {
      await service.view(t);
      return service.documents();
    });
    route('login/challenge', 'POST', 'FamilyChallenge', 'FamilyLoginRequest', (r, t) =>
      service.challenge(
        t,
        (r.body as FamilyLoginRequest).identity,
        undefined,
        ingressIp(r, service.config.proxyKey),
      ),
    );
    route('login', 'POST', 'FamilySession', 'FamilyProofRequest', (r, t) => {
      const b = r.body as FamilyProofRequest;
      return service.verify(t, b.challengeId, b.code, 'LOGIN');
    });
    route('reauth/challenge', 'POST', 'FamilyChallenge', 'FamilyReauthRequest', (r, t) =>
      service.challenge(t, undefined, (r.body as FamilyReauthRequest).action),
    );
    route('reauth', 'POST', 'FamilyReauthResponse', 'FamilyProofRequest', async (r, t) => {
      const b = r.body as FamilyProofRequest;
      return service.verify(t, b.challengeId, b.code, 'REAUTH');
    });
    route('commands', 'POST', 'FamilyResult', 'FamilyCommand', (r, t) => {
      const b = r.body as FamilyCommand;
      return service.command(t, b.action, b.receiptId, b.idempotencyKey);
    });
    route('logout', 'POST', 'FamilyResult', undefined, (_r, t) => service.logout(t));
    done();
  });
}
