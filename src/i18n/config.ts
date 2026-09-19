/** Locales the UI is translated into, and the cookie a user's pick lives in. */
export const SUPPORTED_LOCALES = ['en', 'es', 'ko'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** Names shown in the picker — each in its own language so anyone can find theirs. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  es: 'Español',
  ko: '한국어',
};

export function isSupportedLocale(value: string | null | undefined): value is AppLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
