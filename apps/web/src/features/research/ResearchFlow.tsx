import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@probyu/ui/components/button';
import type { ResearchAnswerRun, ResearchChallengeRun } from '@probyu/contracts/types';

import { ResearchApi, ResearchNetworkError, ResearchRequestError } from './api';
import './research.css';

const kindLabel = {
  MICRO_PROBE: 'Короткая проба',
  EXPERIENCE: 'Опыт',
  PROJECT: 'Мини-проект',
} as const;

const ageLabels = { '8_10': '8–10', '11_12': '11–12', '13_14': '13–14' } as const;
const deadlineFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const pendingStatuses = new Set([
  'RECEIVED',
  'INPUT_APPROVED',
  'QUEUED',
  'GENERATING',
  'OUTPUT_VALIDATING',
  'APPROVED',
  'DELIVERING',
]);
const answerReadyStatuses = new Set(['APPROVED', 'DELIVERING', 'COMPLETED']);

export function ResearchFlow() {
  const { answerRunId } = useParams();
  const navigate = useNavigate();
  const api = useRef(new ResearchApi());
  const channel = useRef<BroadcastChannel | null>(null);
  const generation = useRef(0);
  const streamController = useRef<AbortController | null>(null);
  const questionAttempt = useRef<{ question: string; key: string } | undefined>(undefined);
  const commandAttempts = useRef(new Map<string, string>());
  const commandInFlight = useRef<symbol | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const [access, setAccess] = useState<'checking' | 'child' | 'closed' | 'offline'>('checking');
  const [question, setQuestion] = useState('');
  const [run, setRun] = useState<ResearchAnswerRun>();
  const [challenge, setChallenge] = useState<ResearchChallengeRun>();
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [longWait, setLongWait] = useState(false);
  const [offerExpired, setOfferExpired] = useState(false);
  const [error, setError] = useState('');

  const clearPrivate = useCallback(() => {
    generation.current++;
    streamController.current?.abort();
    streamController.current = null;
    setRun(undefined);
    setChallenge(undefined);
    setQuestion('');
    questionAttempt.current = undefined;
    commandAttempts.current.clear();
    commandInFlight.current = undefined;
    setAccess('checking');
    setLoading(false);
    setWatching(false);
    setCommandBusy(false);
    setLongWait(false);
    setOfferExpired(false);
    setError('');
    api.current.clear();
  }, []);

  const closePrivateForAuthorizationError = useCallback(
    (requestError: unknown) => {
      if (
        !(requestError instanceof ResearchRequestError) ||
        !['UNAUTHENTICATED', 'FORBIDDEN'].includes(requestError.detail.code)
      )
        return false;
      flushSync(() => {
        clearPrivate();
        setAccess('closed');
        setError(requestError.message);
      });
      return true;
    },
    [clearPrivate],
  );

  const load = useCallback(
    async ({ preserveError = false }: { preserveError?: boolean } = {}) => {
      const version = ++generation.current;
      streamController.current?.abort();
      const controller = new AbortController();
      streamController.current = controller;
      const valid = () =>
        version === generation.current &&
        !controller.signal.aborted &&
        document.visibilityState !== 'hidden';
      setLoading(true);
      setWatching(false);
      setLongWait(false);
      setOfferExpired(false);
      if (!preserveError) setError('');
      setRun(undefined);
      setChallenge(undefined);
      setAccess('checking');
      try {
        const session = await api.current.session();
        if (!valid()) return;
        if (session.mode !== 'CHILD' || !session.child?.textAllowed) {
          setAccess('closed');
          return;
        }
        setAccess('child');
        if (!answerRunId) {
          const recovered = await api.current.current();
          if (!valid()) return;
          if (recovered) {
            setRun(recovered);
            setChallenge(recovered.challengeRun);
            void navigate(`/research/${recovered.id}`, { replace: true });
          }
          return;
        }
        let current = await api.current.answer(answerRunId);
        if (!valid()) return;
        setRun(current);
        setChallenge(current.challengeRun);
        if (pendingStatuses.has(current.status) && current.status !== 'COMPLETED') {
          setLoading(false);
          setWatching(true);
          const waitTimer = window.setTimeout(() => {
            if (valid()) setLongWait(true);
          }, 3_000);
          try {
            current =
              (await api.current.stream(answerRunId, controller.signal, (snapshot) => {
                if (!valid()) return;
                setRun(snapshot);
                setChallenge(snapshot.challengeRun);
              })) ?? current;
          } finally {
            window.clearTimeout(waitTimer);
          }
          if (!valid()) return;
          setRun(current);
          setChallenge(current.challengeRun);
          current = await api.current.answer(answerRunId);
          if (!valid()) return;
          setRun(current);
          setChallenge(current.challengeRun);
        }
      } catch (requestError) {
        if (!valid()) return;
        if (closePrivateForAuthorizationError(requestError)) return;
        if (requestError instanceof ResearchNetworkError) {
          setAccess('offline');
        } else {
          setAccess('child');
          if (
            requestError instanceof ResearchRequestError &&
            requestError.detail.code === 'NOT_FOUND'
          ) {
            setRun(undefined);
            setChallenge(undefined);
          }
        }
        setError((requestError as Error).message);
      } finally {
        if (valid()) {
          setLoading(false);
          setWatching(false);
          setLongWait(false);
        }
      }
    },
    [answerRunId, closePrivateForAuthorizationError, navigate],
  );

  useEffect(() => {
    const lifecycle = generation;
    const currentApi = api.current;
    document.title = 'Пробую | Первое исследование';
    const refresh = () => void load();
    const invalidate = () => {
      flushSync(clearPrivate);
      if (document.visibilityState !== 'hidden') refresh();
    };
    const connectChannel = () => {
      channel.current?.close();
      channel.current = new BroadcastChannel('probyu-access');
      channel.current.onmessage = invalidate;
    };
    connectChannel();
    const start = window.setTimeout(refresh, 0);
    const visibility = () => {
      if (document.visibilityState === 'hidden') flushSync(clearPrivate);
      else refresh();
    };
    const restore = () => {
      connectChannel();
      flushSync(clearPrivate);
      refresh();
    };
    const hide = () => {
      flushSync(clearPrivate);
      channel.current?.close();
      channel.current = null;
    };
    const offline = () => {
      flushSync(() => {
        clearPrivate();
        setAccess('offline');
        setError('Соединение пропало. Вопрос повторно отправлять не нужно.');
      });
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', restore);
    window.addEventListener('online', restore);
    window.addEventListener('offline', offline);
    return () => {
      window.clearTimeout(start);
      lifecycle.current++;
      streamController.current?.abort();
      channel.current?.close();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('online', restore);
      window.removeEventListener('offline', offline);
      currentApi.clear();
    };
  }, [clearPrivate, load]);

  const screenKey = `${access}:${run?.status ?? 'none'}:${challenge?.status ?? 'none'}:${offerExpired}`;
  useEffect(() => {
    if (!loading) heading.current?.focus();
  }, [screenKey, loading]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (commandInFlight.current) return;
    const command = Symbol('question');
    const mutationGeneration = generation.current;
    const valid = () =>
      commandInFlight.current === command &&
      mutationGeneration === generation.current &&
      document.visibilityState !== 'hidden';
    const attempt =
      questionAttempt.current?.question === question
        ? questionAttempt.current
        : { question, key: crypto.randomUUID() };
    questionAttempt.current = attempt;
    commandInFlight.current = command;
    setCommandBusy(true);
    setError('');
    try {
      const accepted = await api.current.question(question, attempt.key);
      if (!valid()) return;
      questionAttempt.current = undefined;
      setQuestion('');
      setRun(accepted);
      setChallenge(accepted.challengeRun);
      void navigate(`/research/${accepted.id}`);
    } catch (requestError) {
      if (!valid()) return;
      if (!closePrivateForAuthorizationError(requestError))
        setError(
          requestError instanceof ResearchRequestError && requestError.detail.code === 'CONFLICT'
            ? 'У тебя уже есть незавершённое исследование. Новый вопрос не отправлен. Открой сохранённое состояние и сначала закончи или останови его.'
            : (requestError as Error).message,
        );
    } finally {
      if (commandInFlight.current === command) {
        commandInFlight.current = undefined;
        setCommandBusy(false);
      }
    }
  };

  const cancel = async () => {
    if (!run || commandInFlight.current) return;
    const command = Symbol('cancel');
    const mutationGeneration = generation.current;
    const valid = () =>
      commandInFlight.current === command &&
      mutationGeneration === generation.current &&
      document.visibilityState !== 'hidden';
    commandInFlight.current = command;
    streamController.current?.abort();
    setWatching(false);
    setLongWait(false);
    setCommandBusy(true);
    setError('');
    const attemptId = `answer:${run.id}:cancel`;
    const key = commandAttempts.current.get(attemptId) ?? crypto.randomUUID();
    commandAttempts.current.set(attemptId, key);
    try {
      const value = await api.current.cancel(run.id, key);
      if (!valid()) return;
      commandAttempts.current.delete(attemptId);
      if (answerReadyStatuses.has(value.status)) {
        await load();
        return;
      }
      setRun(value);
      setChallenge(value.challengeRun);
    } catch (requestError) {
      if (!valid()) return;
      if (!closePrivateForAuthorizationError(requestError))
        setError((requestError as Error).message);
    } finally {
      if (commandInFlight.current === command) {
        commandInFlight.current = undefined;
        setCommandBusy(false);
      }
    }
  };

  const offerAction = async (action: 'START' | 'DECLINE') => {
    if (!run?.answer || commandInFlight.current) return;
    const command = Symbol(`offer:${action}`);
    const mutationGeneration = generation.current;
    const valid = () =>
      commandInFlight.current === command &&
      mutationGeneration === generation.current &&
      document.visibilityState !== 'hidden';
    commandInFlight.current = command;
    setCommandBusy(true);
    setError('');
    const attemptId = `offer:${run.answer.challenge.offerId}:${action}`;
    const key = commandAttempts.current.get(attemptId) ?? crypto.randomUUID();
    commandAttempts.current.set(attemptId, key);
    try {
      const value = await api.current.offer(run.answer.challenge.offerId, action, key);
      if (!valid()) return;
      commandAttempts.current.delete(attemptId);
      setOfferExpired(false);
      setChallenge(value);
      setRun({ ...run, challengeRun: value });
    } catch (requestError) {
      if (!valid()) return;
      if (closePrivateForAuthorizationError(requestError)) {
        return;
      } else if (
        requestError instanceof ResearchRequestError &&
        requestError.detail.code === 'OFFER_EXPIRED'
      ) {
        commandAttempts.current.delete(attemptId);
        setOfferExpired(true);
      } else {
        setError((requestError as Error).message);
      }
    } finally {
      if (commandInFlight.current === command) {
        commandInFlight.current = undefined;
        setCommandBusy(false);
      }
    }
  };

  const challengeAction = async (action: 'NEXT' | 'PAUSE' | 'RESUME' | 'CANCEL') => {
    if (!challenge || commandInFlight.current) return;
    const command = Symbol(`challenge:${action}`);
    const mutationGeneration = generation.current;
    const valid = () =>
      commandInFlight.current === command &&
      mutationGeneration === generation.current &&
      document.visibilityState !== 'hidden';
    commandInFlight.current = command;
    setCommandBusy(true);
    setError('');
    const attemptId = `challenge:${challenge.id}:${challenge.rowVersion}:${action}`;
    const key = commandAttempts.current.get(attemptId) ?? crypto.randomUUID();
    commandAttempts.current.set(attemptId, key);
    try {
      const value = await api.current.challenge(challenge.id, action, key, challenge.rowVersion);
      if (!valid()) return;
      commandAttempts.current.delete(attemptId);
      setChallenge(value);
      if (run) setRun({ ...run, challengeRun: value });
    } catch (requestError) {
      if (!valid()) return;
      if (closePrivateForAuthorizationError(requestError)) return;
      const message = (requestError as Error).message;
      await load({ preserveError: true });
      if (commandInFlight.current === command && document.visibilityState !== 'hidden')
        setError(message);
    } finally {
      if (commandInFlight.current === command) {
        commandInFlight.current = undefined;
        setCommandBusy(false);
      }
    }
  };

  return (
    <div className="research-shell">
      <header className="research-header">
        <Link className="wordmark" to="/">
          Пробую
        </Link>
        <span>Режим ребёнка · учебная версия</span>
      </header>
      <main className="research-main" aria-busy={loading || commandBusy}>
        <p className="research-notice">
          Это учебная версия. Ответ готовит тестовая программа, а не настоящий AI. Не пиши имена,
          контакты и адреса.
        </p>
        {error && (
          <div className="research-error" role="alert">
            <p>{error}</p>
            <Button variant="outline" disabled={loading || commandBusy} onClick={() => void load()}>
              Проверить состояние
            </Button>
          </div>
        )}
        {access === 'checking' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Проверяем доступ
            </h1>
            <p>Личные экраны откроются только после ответа сервера.</p>
          </section>
        )}
        {access === 'closed' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Исследования пока закрыты
            </h1>
            <p>Взрослому нужно проверить согласие, паузу или срок доступа.</p>
            <Button asChild>
              <Link to="/family">Вернуть устройство взрослому</Link>
            </Button>
          </section>
        )}
        {access === 'offline' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Для продолжения нужна сеть
            </h1>
            <p>Когда соединение вернётся, мы сначала проверим сохранённое состояние на сервере.</p>
            <Button variant="outline" disabled={loading} onClick={() => void load()}>
              Проверить соединение
            </Button>
          </section>
        )}
        {access === 'child' && !answerRunId && (
          <section>
            <p className="research-eyebrow">Первое исследование</p>
            <h1 ref={heading} tabIndex={-1}>
              Что тебе интересно проверить?
            </h1>
            <p className="research-lead">
              Задай один вопрос. Ответ может ошибаться, а любую пробу можно не начинать или
              остановить.
            </p>
            <div className="research-suggestions" aria-label="Примеры вопросов">
              {[
                'Почему бумага падает по-разному?',
                'Как провести опыт с бумажной дорожкой?',
                'Почему бумажная башня бывает устойчивой?',
              ].map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    questionAttempt.current = undefined;
                    setQuestion(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="research-question">Твой вопрос</label>
              <textarea
                id="research-question"
                required
                minLength={2}
                maxLength={500}
                value={question}
                aria-describedby="research-question-count"
                onChange={(event) => {
                  if (questionAttempt.current?.question !== event.target.value)
                    questionAttempt.current = undefined;
                  setQuestion(event.target.value);
                }}
                placeholder="Например: почему лист кружится, когда падает?"
              />
              <div className="research-count" id="research-question-count">
                {question.length} / 500
              </div>
              <div className="research-actions">
                <Button type="submit" disabled={commandBusy || question.trim().length < 2}>
                  Задать вопрос
                </Button>
                <Button asChild variant="outline">
                  <Link to="/family">Для взрослого</Link>
                </Button>
              </div>
            </form>
          </section>
        )}
        {access === 'child' && answerRunId && !run && !error && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Проверяем вопрос
            </h1>
            <p role="status">Сначала проходят все проверки. Непроверенный текст не показывается.</p>
          </section>
        )}
        {access === 'child' && answerRunId && !run && error && !loading && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Не удалось открыть это исследование
            </h1>
            <p>Можно проверить сохранённое состояние или вернуться к новому вопросу.</p>
            <Button onClick={() => void navigate('/research', { replace: true })}>
              К исследованиям
            </Button>
          </section>
        )}
        {access === 'child' && run && pendingStatuses.has(run.status) && !run.answer && (
          <section>
            <p className="research-eyebrow">Вопрос принят</p>
            <h1 ref={heading} tabIndex={-1}>
              Готовим безопасное объяснение
            </h1>
            <p role="status">
              Можно подождать или остановить запрос. Повторно отправлять его не нужно.
            </p>
            {watching && longWait && (
              <p className="research-limit" role="status">
                Это занимает больше времени, чем обычно. Запрос можно безопасно остановить.
              </p>
            )}
            <Button variant="outline" disabled={commandBusy} onClick={() => void cancel()}>
              Остановить запрос
            </Button>
            <Button variant="ghost" disabled={loading || commandBusy} onClick={() => void load()}>
              Проверить состояние
            </Button>
          </section>
        )}
        {access === 'child' && run?.status === 'DENIED' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              {run.failureCode === 'INPUT_TOO_LONG'
                ? 'Вопрос получился слишком длинным'
                : 'С этим вопросом нужна другая помощь'}
            </h1>
            {run.failureCode === 'INPUT_TOO_LONG' ? (
              <p>Сократи вопрос до 500 знаков и попробуй ещё раз.</p>
            ) : (
              <p>
                Здесь нельзя обрабатывать личные данные или опасные инструкции. Можно задать общий
                безопасный вопрос без имён, контактов и адресов.
              </p>
            )}
            <Button onClick={() => void navigate('/research')}>Задать другой вопрос</Button>
          </section>
        )}
        {access === 'child' && run?.status === 'FAILED_SAFE' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Ответ не прошёл проверку
            </h1>
            <p>Непроверенный текст скрыт. Можно начать новый вопрос позже.</p>
            <Button onClick={() => void navigate('/research')}>Новый вопрос</Button>
          </section>
        )}
        {access === 'child' && run?.status === 'CANCELLED' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Запрос остановлен
            </h1>
            <p>Новый ответ не создаётся. Когда будешь готов, можно начать другое исследование.</p>
            <Button onClick={() => void navigate('/research')}>Новый вопрос</Button>
          </section>
        )}
        {access === 'child' && run?.answer && !challenge && !offerExpired && (
          <section>
            <p className="research-eyebrow">Проверенное объяснение</p>
            <h1 ref={heading} tabIndex={-1}>
              Вот что можно проверить
            </h1>
            <div className="research-answer">
              {run.answer.explanation.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p className="research-role">{run.answer.roleNotice}</p>
            </div>
            <article className="research-card">
              <div className="research-card__topline">
                <span>{kindLabel[run.answer.challenge.kind]}</span>
                <span>{run.answer.challenge.durationMinutes} мин</span>
              </div>
              <h2>{run.answer.challenge.title}</h2>
              <p>{run.answer.challenge.goal}</p>
              <h3>Понадобится</h3>
              <ul>
                {run.answer.challenge.materials.map((material) => (
                  <li key={material}>{material}</li>
                ))}
              </ul>
              <h3>Шаги</h3>
              <ol>
                {run.answer.challenge.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="research-limit">
                Для возраста {run.answer.challenge.ageBands.map((age) => ageLabels[age]).join(', ')}{' '}
                ·{' '}
                {run.answer.challenge.riskClass === 'MINIMAL_RISK'
                  ? 'минимальный риск'
                  : run.answer.challenge.riskClass}{' '}
                ·{' '}
                {run.answer.challenge.supervisionRequirement === 'NONE'
                  ? 'взрослый рядом не требуется'
                  : run.answer.challenge.supervisionRequirement}
              </p>
              <p className="research-limit">
                Начать или вернуться можно до{' '}
                {deadlineFormat.format(new Date(run.answer.challenge.expiresAt))}.
              </p>
              <div className="research-actions">
                <Button disabled={commandBusy} onClick={() => void offerAction('START')}>
                  Начать пробу
                </Button>
                <Button
                  variant="outline"
                  disabled={commandBusy}
                  onClick={() => void offerAction('DECLINE')}
                >
                  Не хочу сейчас
                </Button>
              </div>
            </article>
          </section>
        )}
        {access === 'child' && run?.answer && !challenge && offerExpired && (
          <section>
            <p className="research-eyebrow">Предложение завершено</p>
            <h1 ref={heading} tabIndex={-1}>
              Время для начала этой пробы закончилось
            </h1>
            <p>Можно сразу задать новый вопрос — помощь взрослого не нужна.</p>
            <Button onClick={() => void navigate('/research', { replace: true })}>
              Задать новый вопрос
            </Button>
          </section>
        )}
        {access === 'child' && challenge && challenge.status === 'IN_PROGRESS' && (
          <section>
            <p className="research-eyebrow">
              {kindLabel[challenge.challenge.kind]} · шаг{' '}
              {Math.min(challenge.currentStep + 1, challenge.totalSteps)} из {challenge.totalSteps}
            </p>
            <h1 ref={heading} tabIndex={-1}>
              {challenge.challenge.title}
            </h1>
            {challenge.instructionsComplete ? (
              <div className="research-complete">
                <h2>Все шаги пройдены</h2>
                <p>
                  На следующем этапе здесь появятся результат и добровольная рефлексия. Сейчас можно
                  закончить или начать новый вопрос.
                </p>
                <Button onClick={() => void navigate('/research')}>Закончить исследование</Button>
              </div>
            ) : (
              <div className="research-step">
                <span aria-hidden="true">{challenge.currentStep + 1}</span>
                <p>{challenge.step}</p>
              </div>
            )}
            {!challenge.instructionsComplete && (
              <div className="research-actions">
                <Button
                  disabled={commandBusy || challenge.paused}
                  onClick={() => void challengeAction('NEXT')}
                >
                  Шаг выполнен
                </Button>
                <Button
                  variant="outline"
                  disabled={commandBusy}
                  onClick={() => void challengeAction(challenge.paused ? 'RESUME' : 'PAUSE')}
                >
                  {challenge.paused ? 'Продолжить' : 'Поставить на паузу'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={commandBusy}
                  onClick={() => void challengeAction('CANCEL')}
                >
                  Остановить пробу
                </Button>
              </div>
            )}
            {challenge.paused && (
              <p role="status">
                Пауза сохранена на сервере. Вернуться можно до{' '}
                {deadlineFormat.format(new Date(challenge.expiresAt))}.
              </p>
            )}
          </section>
        )}
        {access === 'child' && challenge?.status === 'DECLINED' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Хорошо, пробу можно не начинать
            </h1>
            <p>Отказ не влияет на оценки — их здесь вообще нет.</p>
            <Button onClick={() => void navigate('/research')}>Задать другой вопрос</Button>
          </section>
        )}
        {access === 'child' && challenge?.status === 'ABANDONED' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Проба остановлена
            </h1>
            <p>Можно закончить на сегодня или выбрать новое исследование.</p>
            <Button onClick={() => void navigate('/research')}>Новое исследование</Button>
          </section>
        )}
        {access === 'child' && challenge?.status === 'BLOCKED_BY_POLICY' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Проба остановлена правилами доступа
            </h1>
            <p>Новые шаги закрыты. Верни устройство взрослому, чтобы проверить доступ.</p>
            <Button asChild>
              <Link to="/family">Вернуть устройство взрослому</Link>
            </Button>
          </section>
        )}
        {access === 'child' && challenge?.status === 'EXPIRED' && (
          <section>
            <h1 ref={heading} tabIndex={-1}>
              Время этой пробы закончилось
            </h1>
            <p>Сохранённые шаги не потерялись, но продолжать старую пробу уже нельзя.</p>
            <Button onClick={() => void navigate('/research')}>Выбрать новое исследование</Button>
          </section>
        )}
      </main>
      <footer className="research-footer">
        <Link to="/family">Вернуть устройство взрослому</Link>
        <span>Без рекламы, рейтингов и сохранения черновика в браузере.</span>
      </footer>
    </div>
  );
}
