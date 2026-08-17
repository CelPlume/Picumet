// i18n 初始化
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './zh';
import { enUS } from './en';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: localStorage.getItem('picumet:locale') ?? 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export function setLocale(locale: string) {
  localStorage.setItem('picumet:locale', locale);
  i18n.changeLanguage(locale);
}

export default i18n;
