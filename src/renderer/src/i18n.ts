import { createContext, useCallback, useContext } from 'react';
import { translate, type Locale } from '@shared/i18n';

export const LocaleContext = createContext<Locale>('ja');

export type T = (key: string, vars?: Record<string, string | number>) => string;

export function useT(): T {
  const locale = useContext(LocaleContext);
  return useCallback<T>((key, vars) => translate(locale, key, vars), [locale]);
}
