import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { isSupportedLocale, LOCALE_COOKIE } from './config';

export default getRequestConfig(async () => {
  // A user's own pick (profile → Language) wins; otherwise the deploy-wide
  // default from the environment, otherwise English.
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const fromEnv = process.env.NEXT_PUBLIC_APP_LOCALE;
  const locale = isSupportedLocale(fromCookie)
    ? fromCookie
    : isSupportedLocale(fromEnv)
      ? fromEnv
      : 'en';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
