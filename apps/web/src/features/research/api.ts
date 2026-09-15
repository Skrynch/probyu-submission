import {
  cancelResearchAnswer,
  createResearchQuestion,
  executeResearchChallengeCommand,
  executeResearchOfferCommand,
  getFamilySession,
  getCurrentResearchAnswer,
  getResearchAnswer,
} from '@probyu/contracts';
import type {
  FamilySession,
  ResearchAnswerRun,
  ResearchChallengeCommand,
  ResearchChallengeRun,
  ResearchError,
  ResearchOfferCommand,
} from '@probyu/contracts/types';

export class ResearchRequestError extends Error {
  constructor(readonly detail: ResearchError) {
    const messages: Record<ResearchError['code'], string> = {
      UNAUTHENTICATED: 'Доступ закончился. Верни устройство взрослому.',
      FORBIDDEN: 'Эту пробу сейчас продолжить нельзя. Верни устройство взрослому.',
      INVALID_REQUEST: 'Проверь вопрос и попробуй ещё раз.',
      CONFLICT: 'Состояние уже изменилось. Сейчас проверим его ещё раз.',
      NOT_FOUND: 'Это исследование больше недоступно.',
      OFFER_EXPIRED: 'Время для начала этой пробы закончилось.',
      RATE_LIMITED: 'Сначала закончи или останови текущее исследование.',
      UNAVAILABLE: 'Сервис временно недоступен. Попробуй ещё раз позже.',
    };
    super(messages[detail.code]);
  }
}

export class ResearchNetworkError extends Error {
  constructor() {
    super('Нет связи с сервером. Проверь подключение и состояние ещё раз.');
  }
}

const finishedStatuses = new Set(['APPROVED', 'COMPLETED', 'DENIED', 'FAILED_SAFE', 'CANCELLED']);

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export class ResearchApi {
  private csrf = '';
  clear(): void {
    this.csrf = '';
  }
  private async data<T>(result: Promise<{ data?: T; error?: unknown }>): Promise<T> {
    let response;
    try {
      response = await result;
    } catch {
      throw new ResearchNetworkError();
    }
    if (response.data === undefined) {
      const detail = response.error as ResearchError | undefined;
      if (detail?.code) throw new ResearchRequestError(detail);
      throw new ResearchNetworkError();
    }
    return response.data;
  }
  async session(): Promise<FamilySession> {
    const view = await this.data(getFamilySession());
    this.csrf = view.csrfToken;
    return view;
  }
  question(question: string, idempotencyKey: string): Promise<ResearchAnswerRun> {
    return this.data(
      createResearchQuestion({
        headers: { 'X-CSRF-Token': this.csrf },
        body: { question, idempotencyKey },
      }),
    );
  }
  answer(answerRunId: string): Promise<ResearchAnswerRun> {
    return this.data(getResearchAnswer({ path: { answerRunId } }));
  }
  async current(): Promise<ResearchAnswerRun | undefined> {
    return (await this.data(getCurrentResearchAnswer())).answer;
  }
  cancel(answerRunId: string, idempotencyKey: string): Promise<ResearchAnswerRun> {
    return this.data(
      cancelResearchAnswer({
        path: { answerRunId },
        headers: { 'X-CSRF-Token': this.csrf },
        body: { idempotencyKey },
      }),
    );
  }
  offer(
    offerId: string,
    action: ResearchOfferCommand['action'],
    idempotencyKey: string,
  ): Promise<ResearchChallengeRun> {
    return this.data(
      executeResearchOfferCommand({
        path: { offerId },
        headers: { 'X-CSRF-Token': this.csrf },
        body: { action, idempotencyKey },
      }),
    );
  }
  challenge(
    challengeRunId: string,
    action: ResearchChallengeCommand['action'],
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<ResearchChallengeRun> {
    return this.data(
      executeResearchChallengeCommand({
        path: { challengeRunId },
        headers: { 'X-CSRF-Token': this.csrf },
        body: { action, idempotencyKey, expectedVersion },
      }),
    );
  }
  async stream(
    answerRunId: string,
    signal: AbortSignal,
    onSnapshot?: (run: ResearchAnswerRun) => void,
  ): Promise<ResearchAnswerRun | undefined> {
    let cursor = 0;
    let latest: ResearchAnswerRun | undefined;
    let networkFailed = false;
    for (let reconnect = 0; reconnect < 3 && !signal.aborted; reconnect++) {
      let response: Response;
      try {
        response = await fetch(`/v1/research/answers/${answerRunId}/events?cursor=${cursor}`, {
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) },
          signal,
        });
      } catch {
        if (signal.aborted) return latest;
        networkFailed = true;
        await wait(250 * (reconnect + 1), signal);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.json().catch(() => undefined)) as ResearchError | undefined;
        if (detail?.code) throw new ResearchRequestError(detail);
        networkFailed = true;
        await wait(250 * (reconnect + 1), signal);
        continue;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        networkFailed = true;
        continue;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const event of events) {
            const lines = event.split('\n');
            const id = lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim();
            const data = lines
              .find((line) => line.startsWith('data:'))
              ?.slice(5)
              .trim();
            if (id && /^\d+$/.test(id)) cursor = Math.max(cursor, Number(id));
            if (!data) continue;
            try {
              latest = JSON.parse(data) as ResearchAnswerRun;
            } catch {
              throw new ResearchNetworkError();
            }
            onSnapshot?.(latest);
            if (finishedStatuses.has(latest.status)) return latest;
          }
          if (chunk.done) break;
        }
      } catch (error) {
        if (signal.aborted) return latest;
        if (error instanceof ResearchNetworkError) throw error;
        networkFailed = true;
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    }
    for (let poll = 0; poll < 4 && !signal.aborted; poll++) {
      try {
        latest = await this.answer(answerRunId);
        onSnapshot?.(latest);
        if (finishedStatuses.has(latest.status)) return latest;
        networkFailed = false;
      } catch (error) {
        if (error instanceof ResearchRequestError) throw error;
        networkFailed = true;
      }
      await wait(750, signal);
    }
    if (networkFailed && !signal.aborted) throw new ResearchNetworkError();
    return latest;
  }
}
