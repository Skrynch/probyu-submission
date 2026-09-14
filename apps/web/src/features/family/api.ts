import {
  bootstrapFamily,
  challengeFamilyLogin,
  challengeFamilyReauth,
  executeFamilyCommand,
  getFamilyDocuments,
  getFamilySession,
  loginFamily,
  logoutFamily,
  verifyFamilyReauth,
} from '@probyu/contracts';
import type {
  FamilyAction,
  FamilyChallenge,
  FamilyDocuments,
  FamilyError,
  FamilySession,
} from '@probyu/contracts/types';

export class FamilyRequestError extends Error {
  constructor(readonly detail: FamilyError) {
    const messages: Record<FamilyError['code'], string> = {
      INVALID_CODE: `Код не совпал. Осталось попыток: ${detail.remainingAttempts ?? 0}.`,
      EXPIRED_PROOF: 'Код истёк или уже использован. Запросите новый код.',
      RATE_LIMITED: `Слишком много попыток. Повторите не позднее чем через ${Math.ceil((detail.retryAfterSeconds ?? 900) / 60)} минут. Взрослый может войти из другого браузера.`,
      UNAUTHENTICATED: 'Сессия истекла. Начните новый вход.',
      FORBIDDEN:
        'Действие недоступно. Проверьте взрослый доступ и срок подтверждения семьи; при необходимости войдите заново.',
      CONFLICT: 'Состояние изменилось. Проверьте доступ и повторите действие.',
      INVALID_REQUEST: 'Проверьте введённые данные.',
      UNAVAILABLE: 'Сервис временно недоступен. Повторите проверку позже.',
    };
    super(messages[detail.code]);
  }
}

export class FamilyApi {
  private csrf = '';
  private headers() {
    return { 'X-CSRF-Token': this.csrf };
  }
  private async data<T>(result: Promise<{ data?: T; error?: unknown }>): Promise<T> {
    let response;
    try {
      response = await result;
    } catch {
      throw new Error('Нет связи с сервером. Проверьте подключение и повторите проверку доступа.');
    }
    if (response.data === undefined) {
      const detail = response.error as FamilyError | undefined;
      if (detail?.code) throw new FamilyRequestError(detail);
      throw new Error('Нет связи с сервером. Проверьте подключение и повторите проверку доступа.');
    }
    return response.data;
  }
  private remember(view: FamilySession) {
    this.csrf = view.csrfToken;
    return view;
  }
  async bootstrap() {
    return this.remember(
      await this.data(bootstrapFamily({ headers: { 'X-Probyu-Bootstrap': '1' } })),
    );
  }
  async view() {
    return this.remember(await this.data(getFamilySession()));
  }
  documents(): Promise<FamilyDocuments> {
    return this.data(getFamilyDocuments());
  }
  loginChallenge(identity: 'aurora' | 'comet'): Promise<FamilyChallenge> {
    return this.data(challengeFamilyLogin({ headers: this.headers(), body: { identity } }));
  }
  async login(challengeId: string, code: string) {
    return this.remember(
      await this.data(loginFamily({ headers: this.headers(), body: { challengeId, code } })),
    );
  }
  challenge(action: FamilyAction) {
    return this.data(challengeFamilyReauth({ headers: this.headers(), body: { action } }));
  }
  async execute(action: FamilyAction, challengeId: string, code: string, idempotencyKey: string) {
    const proof = await this.data(
      verifyFamilyReauth({ headers: this.headers(), body: { challengeId, code } }),
    );
    await this.data(
      executeFamilyCommand({
        headers: this.headers(),
        body: { action, receiptId: proof.receiptId, idempotencyKey },
      }),
    );
    return action.kind === 'REVOKE_BROWSER' ? undefined : this.view();
  }
  async logout() {
    await this.data(logoutFamily({ headers: this.headers() }));
    this.csrf = '';
  }
  clear() {
    this.csrf = '';
  }
}
