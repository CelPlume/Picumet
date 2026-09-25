// 落地页：独立视觉系统（components/landing/）。强调色跟随个性化设置（默认 #D8632B），
// 其余外观（模糊/壁纸/动画档位）不消费；只跟随明暗与语言。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Github, BookOpen } from 'lucide-react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@/components/landing/landing.css';
import { Logo } from '@/components/layout/Logo';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import { useSite } from '@/stores/site';
import { useAuth } from '@/stores/auth';
import { accentHsl, useTheme } from '@/stores/theme';
import { BRAND_URL, REPO_URL, docsUrl, useRevealRoot } from '@/components/landing/primitives';
import { Admin, Cta, Deploy, Details, Edge, Faq, Hero, Integrations, Pool, Providers, Security, Workflow } from '@/components/landing/sections';

export default function Landing() {
  const { t, i18n } = useTranslation();
  const site = useSite();
  const loggedIn = useAuth((s) => !!s.user);
  const accent = useTheme((s) => s.accentColor);
  const { primary, foreground } = accentHsl(accent);
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const zh = i18n.language?.startsWith('zh') ?? true;
  useRevealRoot(rootRef);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      ref={rootRef}
      className="landing min-h-screen overflow-x-clip"
      lang={zh ? 'zh' : 'en'}
      // 强调色跟随个性化设置（默认 #D8632B）：内联变量覆盖 landing.css 的回退值
      style={{ '--primary': primary, '--primary-foreground': foreground } as CSSProperties}
    >
      <header className="lp-header fixed inset-x-0 top-0 z-40" data-scrolled={scrolled ? '' : undefined}>
        <div className="lp-container flex h-14 items-center gap-6">
          <Link to="/" aria-label={site.siteTitle ?? 'Picumet'}>
            <Logo size={40} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} siteHeaderTitle={site.siteHeaderTitle} />
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="lp-icon-btn lp-hide-sm" aria-label="GitHub">
              <Github className="size-4" />
            </a>
            <ThemeToggle />
            <LanguageSwitcher />
            <a href={docsUrl(zh)} target="_blank" rel="noreferrer" className="lp-btn lp-btn-ghost lp-btn-sm" aria-label={t('landing.hero.docs')}>
              <BookOpen className="size-4" />
              <span className="max-sm:hidden">{t('landing.hero.docs')}</span>
            </a>
            <Link to={loggedIn ? '/files' : '/login'} className="lp-btn lp-btn-ink lp-btn-sm ml-2">
              {loggedIn ? t('landing.hero.openApp') : t('common.login')}
            </Link>
          </div>
        </div>
      </header>

      <main>
        <Hero loggedIn={loggedIn} />
        <Providers />
        <Workflow />
        <Pool />
        <Admin />
        <Details />
        <Integrations />
        <Security />
        <Edge />
        <Deploy />
        <Faq />
        <Cta loggedIn={loggedIn} />
      </main>

      <footer className="overflow-hidden border-t">
        <div className="lp-container flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted-foreground">
          <span>
            © {new Date().getFullYear()}{' '}
            <a href={BRAND_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
              {t('landing.footer.brand')}
            </a>{' '}
            {t('landing.footer.rights')}
          </span>
          <div className="flex items-center gap-6">
            <a href={docsUrl(zh)} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
              {t('landing.footer.docs')}
            </a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
              GitHub
            </a>
          </div>
        </div>
        <p className="lp-wordmark lp-container -mb-[0.12em] text-center text-[clamp(5rem,21vw,17rem)]" aria-hidden>
          Picumet
        </p>
      </footer>
    </div>
  );
}
