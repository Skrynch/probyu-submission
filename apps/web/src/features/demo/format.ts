const MINUTE_FORMS = ['минута', 'минуты', 'минут'] as const;

export function formatMinutes(value: number): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const form =
    mod10 === 1 && mod100 !== 11
      ? MINUTE_FORMS[0]
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? MINUTE_FORMS[1]
        : MINUTE_FORMS[2];
  return `${String(value)} ${form}`;
}
