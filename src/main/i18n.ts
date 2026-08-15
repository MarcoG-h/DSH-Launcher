// Main-process i18n: pick the Chinese or English wording for a log line / error
// based on the persisted config language. Chinese is always the default and is
// kept verbatim; English is provided for non-Chinese users.

import { getConfig } from './config'

/** Return the English wording when the app language is English, Chinese otherwise. */
export function t(zh: string, en: string): string {
  return getConfig().language === 'en' ? en : zh
}
