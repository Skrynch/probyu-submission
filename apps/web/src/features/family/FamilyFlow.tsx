import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { Button } from '@probyu/ui/components/button';
import type {
  FamilyAction,
  FamilyChallenge,
  FamilyDocuments,
  FamilySession,
} from '@probyu/contracts/types';
import { FamilyApi, FamilyRequestError } from './api';
import './family.css';

type Pending = { challenge: FamilyChallenge; action?: FamilyAction; key: string };
const actionLabels: Record<FamilyAction['kind'], string> = {
  ACTIVATE: 'Активировать учебный профиль',
  CONSENT: 'Изменить согласие',
  HANDOFF: 'Передать ребёнку',
  RETURN: 'Вернуться во взрослый режим',
  PAUSE: 'Приостановить доступ',
  RESUME: 'Возобновить доступ',
  REVOKE_BROWSER: 'Отозвать этот браузер',
};

export function FamilyFlow() {
  const api = useRef(new FamilyApi());
  const channel = useRef<BroadcastChannel | null>(null);
  const generation = useRef(0);
  const main = useRef<HTMLElement>(null);
  const [view, setView] = useState<FamilySession>();
  const [documents, setDocuments] = useState<FamilyDocuments>();
  const [pending, setPending] = useState<Pending>();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [curtain, setCurtain] = useState(true);
  const [text, setText] = useState(false);
  const [history, setHistory] = useState(false);
  const [ageBand, setAgeBand] = useState<'8_10' | '11_12' | '13_14'>('8_10');
  const clear = useCallback(() => {
    generation.current++;
    setView(undefined);
    setDocuments(undefined);
    setPending(undefined);
    setCode('');
    setText(false);
    setHistory(false);
    setCurtain(true);
    setBusy(false);
    api.current.clear();
  }, []);
  const refresh = useCallback(async (bootstrap = false) => {
    const version = ++generation.current;
    setCurtain(true);
    setBusy(true);
    setPending(undefined);
    setCode('');
    setError('');
    try {
      const current = bootstrap ? await api.current.bootstrap() : await api.current.view();
      const docs = await api.current.documents();
      if (version !== generation.current || document.visibilityState === 'hidden') return;
      setView(current);
      setDocuments(docs);
      setCurtain(false);
    } catch {
      if (version === generation.current) {
        setView(undefined);
        setError('Доступ не подтверждён. Проверьте соединение или начните новый вход.');
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    const lifecycle = generation;
    const currentApi = api.current;
    document.title = 'Пробую | Учебная семья';
    const invalidate = () => {
      flushSync(clear);
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const connectChannel = () => {
      channel.current?.close();
      channel.current = new BroadcastChannel('probyu-access');
      channel.current.onmessage = invalidate;
    };
    connectChannel();
    const hide = () => {
      if (document.visibilityState === 'hidden') flushSync(clear);
      else void refresh();
    };
    const restore = () => {
      connectChannel();
      flushSync(clear);
      void refresh();
    };
    const pagehide = () => {
      flushSync(clear);
      // A frozen document cannot receive invalidation; reconnect and revalidate on pageshow.
      channel.current?.close();
      channel.current = null;
    };
    const offline = () => flushSync(clear);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', restore);
    window.addEventListener('offline', offline);
    const start = window.setTimeout(() => void refresh(true), 0);
    return () => {
      window.clearTimeout(start);
      lifecycle.current++;
      channel.current?.close();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('offline', offline);
      currentApi.clear();
    };
  }, [clear, refresh]);
  useEffect(() => {
    if (busy || curtain || !view) return;
    // Validate silently; a matching server snapshot does not destroy the user's in-flight form.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const version = generation.current;
      void api.current
        .view()
        .then((current) => {
          if (version !== generation.current) return;
          if (JSON.stringify(current) !== JSON.stringify(view)) {
            clear();
            void refresh();
          }
        })
        .catch(() => {
          if (version === generation.current) {
            clear();
            setError('Не удалось проверить доступ. Проверьте соединение.');
          }
        });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [view, busy, curtain, clear, refresh]);
  useEffect(() => {
    if (busy) return;
    const target =
      pending && !curtain
        ? main.current?.querySelector<HTMLInputElement>('#adult-code')
        : main.current?.querySelector<HTMLHeadingElement>('h1');
    target?.focus();
  }, [pending, curtain, view?.mode, view?.child?.id, busy]);
  const begin = async (action?: FamilyAction, identity: 'aurora' | 'comet' = 'aurora') => {
    setBusy(true);
    setError('');
    const version = ++generation.current;
    try {
      const challenge = action
        ? await api.current.challenge(action)
        : await api.current.loginChallenge(identity);
      if (version === generation.current)
        setPending({ challenge, ...(action ? { action } : {}), key: crypto.randomUUID() });
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending) return;
    const request = pending;
    const entered = code;
    setCode('');
    setPending(undefined);
    setText(false);
    setHistory(false);
    setBusy(true);
    setCurtain(true);
    setView(undefined);
    setError('');
    const version = ++generation.current;
    try {
      const current = request.action
        ? await api.current.execute(
            request.action,
            request.challenge.challengeId,
            entered,
            request.key,
          )
        : await api.current.login(request.challenge.challengeId, entered);
      channel.current?.postMessage('invalidate');
      if (version !== generation.current) return;
      if (current) {
        setView(current);
        setCurtain(false);
      } else {
        api.current.clear();
        setError('Доступ этого браузера отозван.');
      }
    } catch (e) {
      if (version === generation.current) {
        setError((e as Error).message);
        if (e instanceof FamilyRequestError && e.detail.code === 'INVALID_CODE') {
          // The server explicitly confirms this same proof is still usable. Never restore on unknown outcome.
          try {
            const current = await api.current.view();
            if (version === generation.current) {
              setPending(request);
              setView(current);
              setCurtain(false);
            }
          } catch {
            /* Keep the private surface closed on failed revalidation. */
          }
        }
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  const logout = async () => {
    const version = ++generation.current;
    setBusy(true);
    setCurtain(true);
    setView(undefined);
    try {
      await api.current.logout();
      if (version !== generation.current) return;
      channel.current?.postMessage('invalidate');
      clear();
      await refresh(true);
    } catch {
      if (version !== generation.current) return;
      clear();
      setError(
        'Не удалось завершить сессию на сервере. Повторите выход после восстановления связи.',
      );
    } finally {
      setBusy(false);
    }
  };
  const child = view?.child;
  return (
    <div className="family-shell">
      <header className="family-header">
        <Link className="wordmark" to="/">
          Пробую
        </Link>
        <span>Учебная семья</span>
      </header>
      <main className="family-main" id="main" ref={main}>
        <p className="family-notice">
          Локальный стенд · только вымышленные семьи. Реальный вход и AI выключены.
        </p>
        {error && (
          <p className="family-error" role="alert">
            {error}
          </p>
        )}
        {curtain ? (
          <section aria-busy={busy}>
            <h1 tabIndex={-1}>Проверка доступа</h1>
            <p>Личные экраны закрыты до ответа сервера.</p>
            <div className="family-actions">
              <Button disabled={busy} onClick={() => void refresh()}>
                Проверить доступ
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void refresh(true)}>
                Начать новый вход
              </Button>
            </div>
          </section>
        ) : (
          <>
            {pending ? (
              <section>
                <h1 tabIndex={-1}>Подтвердите действие</h1>
                <p>{pending.action ? actionLabels[pending.action.kind] : 'Вход в учебную семью'}</p>
                <p className="family-code">
                  Учебный код: <strong data-testid="dev-code">{pending.challenge.devCode}</strong>
                </p>
                <p>
                  Это имитация отдельного взрослого канала для проверки стенда. Срок кода — 5 минут.
                </p>
                <form onSubmit={(event) => void submit(event)}>
                  <label htmlFor="adult-code">Одноразовый код</label>
                  <input
                    id="adult-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <div className="family-actions">
                    <Button disabled={busy} type="submit">
                      Подтвердить
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void refresh();
                      }}
                    >
                      Отмена
                    </Button>
                  </div>
                </form>
              </section>
            ) : (
              <>
                {view?.mode === 'ANONYMOUS' && (
                  <section>
                    <h1 tabIndex={-1}>Пространство для семьи</h1>
                    <p>
                      Здесь взрослый управляет доступом ребёнка и выбирает, сохранять ли историю
                      исследований.
                    </p>
                    <p>Для проверки используйте одну из двух вымышленных семей.</p>
                    <div className="family-actions">
                      <Button disabled={busy} onClick={() => void begin(undefined, 'aurora')}>
                        Войти: Аврора
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void begin(undefined, 'comet')}
                      >
                        Войти: Комета
                      </Button>
                    </div>
                    <Link to="/">Открыть готовый пример без входа</Link>
                  </section>
                )}
                {view?.mode === 'LOCKED' && (
                  <section>
                    <h1 tabIndex={-1}>Взрослый режим закрыт</h1>
                    <p>Для продолжения нужно новое подтверждение взрослого.</p>
                    <Button disabled={busy} onClick={() => void begin({ kind: 'RETURN' })}>
                      Подтвердить взрослый доступ
                    </Button>
                  </section>
                )}
                {view?.mode === 'PARENT' && !child && documents && (
                  <section>
                    <h1 tabIndex={-1}>Начнём с разрешений</h1>
                    <p>
                      Учебный профиль — «Исследователь». Имя, контакты и дату рождения ребёнка
                      вводить не нужно.
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void begin({
                          kind: 'ACTIVATE',
                          documentVersion: documents.version,
                          ageBand,
                          text,
                          history,
                        });
                      }}
                    >
                      <label htmlFor="age-band">Возрастная группа</label>
                      <select
                        id="age-band"
                        value={ageBand}
                        onChange={(e) => setAgeBand(e.target.value as typeof ageBand)}
                      >
                        <option value="8_10">8–10 лет</option>
                        <option value="11_12">11–12 лет</option>
                        <option value="13_14">13–14 лет</option>
                      </select>
                      <label className="family-choice">
                        <input
                          type="checkbox"
                          checked={text}
                          onChange={(e) => setText(e.target.checked)}
                        />
                        <span>
                          <strong>Базовый текстовый сценарий</strong>
                          {documents.text}
                        </span>
                      </label>
                      <label className="family-choice">
                        <input
                          type="checkbox"
                          checked={history}
                          onChange={(e) => setHistory(e.target.checked)}
                        />
                        <span>
                          <strong>История исследований — по желанию</strong>
                          {documents.history}
                        </span>
                      </label>
                      {!text && <p>Без разрешения доступен готовый пример без входа.</p>}
                      <div className="family-actions">
                        <Button type="submit" disabled={!text || busy}>
                          Продолжить с этими разрешениями
                        </Button>
                        <Link to="/">Пока без профиля</Link>
                      </div>
                    </form>
                  </section>
                )}
                {view?.mode === 'PARENT' && child && documents && (
                  <section>
                    <p className="family-eyebrow">Взрослый режим</p>
                    <h1 tabIndex={-1}>Исследователь</h1>
                    <p>
                      Возраст:{' '}
                      {{ '8_10': '8–10', '11_12': '11–12', '13_14': '13–14' }[child.ageBand]} лет
                    </p>
                    <dl className="family-status">
                      <div>
                        <dt>Доступ</dt>
                        <dd>
                          {child.status === 'PAUSED'
                            ? 'Приостановлен'
                            : child.textAllowed
                              ? 'Разрешён'
                              : 'Нужно согласие'}
                        </dd>
                      </div>
                      <div>
                        <dt>История</dt>
                        <dd>{child.historyGranted ? 'Разрешена' : 'Выключена'}</dd>
                      </div>
                    </dl>
                    <div className="family-actions">
                      <Button
                        disabled={busy || !child.textAllowed}
                        onClick={() => void begin({ kind: 'HANDOFF', childId: child.id })}
                      >
                        Передать ребёнку
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void begin({
                            kind: child.status === 'PAUSED' ? 'RESUME' : 'PAUSE',
                            childId: child.id,
                          })
                        }
                      >
                        {child.status === 'PAUSED' ? 'Возобновить доступ' : 'Приостановить доступ'}
                      </Button>
                    </div>
                    <h2>Согласия</h2>
                    <p>Каждое изменение требует нового подтверждения взрослого.</p>
                    {child.textExpiresAt && (
                      <p>
                        {child.textGranted
                          ? 'Текстовое согласие до '
                          : 'Текстовое согласие больше не действует. Срок до '}
                        {new Date(child.textExpiresAt).toLocaleDateString('ru-RU')}.
                      </p>
                    )}
                    {child.historyExpiresAt && (
                      <p>
                        {child.historyGranted
                          ? 'Согласие на историю до '
                          : 'Согласие на историю больше не действует. Срок до '}
                        {new Date(child.historyExpiresAt).toLocaleDateString('ru-RU')}.
                      </p>
                    )}
                    {!child.textAllowed && child.status !== 'PAUSED' && (
                      <p>
                        Если подтверждение семьи истекло, выйдите из сессии и войдите заново.
                        Согласия затем нужно выдать отдельно.
                      </p>
                    )}
                    <div className="family-actions">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void begin({
                            kind: 'CONSENT',
                            childId: child.id,
                            documentVersion: documents.version,
                            purpose: 'TEXT',
                            granted: !child.textGranted,
                          })
                        }
                      >
                        {child.textGranted
                          ? 'Отозвать текстовое согласие'
                          : 'Разрешить текстовый сценарий'}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void begin({
                            kind: 'CONSENT',
                            childId: child.id,
                            documentVersion: documents.version,
                            purpose: 'HISTORY',
                            granted: !child.historyGranted,
                          })
                        }
                      >
                        {child.historyGranted ? 'Выключить историю' : 'Разрешить историю'}
                      </Button>
                    </div>
                    <h2>Этот браузер</h2>
                    <p>
                      Отзыв закроет доступ во всех его вкладках. Для повторного доступа потребуется
                      новый вход.
                    </p>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void begin({ kind: 'REVOKE_BROWSER' })}
                    >
                      Отозвать доступ браузера
                    </Button>
                  </section>
                )}
                {view?.mode === 'CHILD' && (
                  <section>
                    <p className="family-eyebrow">Детский режим</p>
                    <h1 tabIndex={-1}>
                      {child?.textAllowed
                        ? 'Привет, Исследователь!'
                        : 'Исследования пока недоступны'}
                    </h1>
                    <p>
                      {child?.textAllowed
                        ? 'Всё начинается с любопытства. Теперь можно задать вопрос и пройти безопасную учебную пробу.'
                        : 'Взрослому нужно проверить разрешения или снять паузу.'}
                    </p>
                    <p>
                      AI может ошибаться. Не сообщай личные данные. Можно остановиться в любой
                      момент.
                    </p>
                    <div className="family-actions">
                      {child?.textAllowed ? (
                        <Button asChild>
                          <Link to="/research">Начать исследование</Link>
                        </Button>
                      ) : (
                        <Button disabled>Начать исследование</Button>
                      )}
                      <Button asChild variant="outline">
                        <Link to="/">Открыть готовый пример</Link>
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void begin({ kind: 'RETURN' })}
                      >
                        Для взрослого
                      </Button>
                    </div>
                  </section>
                )}
              </>
            )}
            {view?.mode !== 'ANONYMOUS' && !pending && (
              <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
                Выйти из сессии
              </Button>
            )}
          </>
        )}
      </main>
      <footer className="family-footer">
        Согласия здесь учебные. Это не допуск реальных семей к продукту.
      </footer>
    </div>
  );
}
