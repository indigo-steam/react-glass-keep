import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import es from './locales/es.json';

const resources = {
  en: { translation: en },
  es: { translation: es }
};

const savedLanguage = localStorage.getItem('indigo-notes-language');
const browserLanguage = navigator.language?.split('-')[0] || 'en';
const defaultLanguage = savedLanguage || (['en', 'es'].includes(browserLanguage) ? browserLanguage : 'en');

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: defaultLanguage,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  });

export default i18n;