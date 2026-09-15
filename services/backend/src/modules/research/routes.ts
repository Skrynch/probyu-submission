import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as schemas from '@probyu/contracts/schemas';
import type {
  ResearchChallengeCommand,
  ResearchIdempotentCommand,
  ResearchOfferCommand,
  ResearchQuestionRequest,
} from '@probyu/contracts/types';

import { ingressIp } from '../family/ingress.js';
import { AccessError, equalDigest } from '../family/policy.js';
import type { ResearchService } from './service.js';

const COOKIE = '__Host-probuyu_session';

function schema(name: string): Record<string, unknown> {
  const value = (schemas as Record<string, unknown>)[`${name}Schema`];
  if (!value) throw new Error(`Missing contract ${name}`);
  function resolve(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(resolve);
    if (item && typeof item === 'object') {
      const object = item as Record<string, unknown>;
      if (typeof object.$ref === 'string') return schema(object.$ref.split('/').at(-1)!);
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, resolve(child)]),
      );
    }
    return item;
  }
  return resolve(value) as Record<string, unknown>;
}

function cookie(request: FastifyRequest): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

const terminal = new Set(['COMPLETED', 'DENIED', 'FAILED_SAFE', 'CANCELLED']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerResearchRoutes(app: FastifyInstance, service: ResearchService): void {
  void app.register((researchApp, _options, done) => {
    researchApp.addHook('onRequest', (request, reply, next) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      ingressIp(request, service.family.config.proxyKey);
      const token = cookie(request);
      if (!token) throw new AccessError('UNAUTHENTICATED', 401);
      if (request.method === 'POST') {
        if (
          request.headers.origin !== service.family.config.origin ||
          request.headers['sec-fetch-site'] === 'cross-site' ||
          !equalDigest(request.headers['x-csrf-token'], service.family.csrf(token))
        )
          throw new AccessError('FORBIDDEN');
      }
      next();
    });
    researchApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof AccessError) {
        if (error.code === 'RATE_LIMITED') reply.header('Retry-After', '3');
        void reply.code(error.status).send({
          code: error.code,
          ...(error.code === 'RATE_LIMITED' ? { retryAfterSeconds: 3 } : {}),
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
      app.log.warn('research operation unavailable');
      void reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    const failures = {
      400: schema('ResearchError'),
      401: schema('ResearchError'),
      403: schema('ResearchError'),
      404: schema('ResearchError'),
      409: schema('ResearchError'),
      429: schema('ResearchError'),
      503: schema('ResearchError'),
    };
    const offerFailures = { ...failures, 410: schema('ResearchError') };
    researchApp.post(
      '/v1/research/questions',
      {
        bodyLimit: 2048,
        schema: {
          body: schema('ResearchQuestionRequest'),
          response: {
            200: schema('ResearchAnswerRun'),
            202: schema('ResearchAnswerRun'),
            ...failures,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as ResearchQuestionRequest;
        const result = await service.createQuestion(
          cookie(request)!,
          body.question,
          body.idempotencyKey,
        );
        return reply.code(result.created ? 202 : 200).send(result.view);
      },
    );
    researchApp.get(
      '/v1/research/answers/current',
      {
        schema: {
          response: { 200: schema('ResearchCurrentAnswer'), ...failures },
        },
      },
      (request) => service.currentAnswer(cookie(request)!),
    );
    researchApp.get(
      '/v1/research/answers/:answerRunId',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['answerRunId'],
            properties: { answerRunId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: schema('ResearchAnswerRun'), ...failures },
        },
      },
      (request) =>
        service.getAnswer(
          cookie(request)!,
          (request.params as { answerRunId: string }).answerRunId,
        ),
    );
    researchApp.post(
      '/v1/research/answers/:answerRunId/cancel',
      {
        bodyLimit: 512,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['answerRunId'],
            properties: { answerRunId: { type: 'string', format: 'uuid' } },
          },
          body: schema('ResearchIdempotentCommand'),
          response: { 200: schema('ResearchAnswerRun'), ...failures },
        },
      },
      (request) =>
        service.cancelAnswer(
          cookie(request)!,
          (request.params as { answerRunId: string }).answerRunId,
          (request.body as ResearchIdempotentCommand).idempotencyKey,
        ),
    );
    researchApp.post(
      '/v1/research/offers/:offerId/commands',
      {
        bodyLimit: 512,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['offerId'],
            properties: { offerId: { type: 'string', format: 'uuid' } },
          },
          body: schema('ResearchOfferCommand'),
          response: { 200: schema('ResearchChallengeRun'), ...offerFailures },
        },
      },
      (request) => {
        const body = request.body as ResearchOfferCommand;
        return service.offerCommand(
          cookie(request)!,
          (request.params as { offerId: string }).offerId,
          body.action,
          body.idempotencyKey,
        );
      },
    );
    researchApp.post(
      '/v1/research/challenges/:challengeRunId/commands',
      {
        bodyLimit: 512,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['challengeRunId'],
            properties: { challengeRunId: { type: 'string', format: 'uuid' } },
          },
          body: schema('ResearchChallengeCommand'),
          response: { 200: schema('ResearchChallengeRun'), ...failures },
        },
      },
      (request) => {
        const body = request.body as ResearchChallengeCommand;
        return service.challengeCommand(
          cookie(request)!,
          (request.params as { challengeRunId: string }).challengeRunId,
          body.action,
          body.idempotencyKey,
          body.expectedVersion,
        );
      },
    );
    researchApp.get('/v1/research/answers/:answerRunId/events', async (request, reply) => {
      const token = cookie(request)!;
      const answerRunId = (request.params as { answerRunId: string }).answerRunId;
      const queryCursor = Number((request.query as { cursor?: string }).cursor ?? 0);
      const headerCursor = Number(request.headers['last-event-id'] ?? 0);
      if (
        !uuid.test(answerRunId) ||
        !Number.isInteger(queryCursor) ||
        !Number.isInteger(headerCursor) ||
        queryCursor < 0 ||
        headerCursor < 0
      )
        throw new AccessError('INVALID_REQUEST', 400);
      let cursor = Math.max(queryCursor, headerCursor);
      let event = await service.answerEvents(token, answerRunId, cursor);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try {
        for (let attempt = 0; attempt < 48 && !reply.raw.destroyed; attempt++) {
          if (event.sequences.length) {
            cursor = event.sequences.at(-1)!;
            const accepted = reply.raw.write(
              `id: ${String(cursor)}\nevent: snapshot\ndata: ${JSON.stringify(event.view)}\n\n`,
            );
            if (!accepted) {
              const drained = await new Promise<boolean>((resolve) => {
                const cleanup = () => {
                  reply.raw.off('drain', onDrain);
                  reply.raw.off('close', onClose);
                };
                const onDrain = () => {
                  cleanup();
                  resolve(true);
                };
                const onClose = () => {
                  cleanup();
                  resolve(false);
                };
                reply.raw.once('drain', onDrain);
                reply.raw.once('close', onClose);
              });
              if (!drained) break;
            }
          }
          if (terminal.has(event.view.status) || event.view.status === 'APPROVED') {
            if (event.view.status === 'APPROVED')
              await service.completeDelivery(token, answerRunId);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          event = await service.answerEvents(token, answerRunId, cursor);
        }
      } finally {
        reply.raw.end();
      }
    });
    done();
  });
}
