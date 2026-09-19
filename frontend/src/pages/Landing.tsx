// 落地页
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Cloud, Zap, Link2, Palette, Globe, ArrowRight, Github, BookOpen, Rocket } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/core';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';
import { useSite } from '@/stores/site';

export default function Landing() {
  const { t } = useTranslation();
  const site = useSite();

  const features = [
    { icon: ShieldCheck, title: t('landing.feature1'), desc: t('landing.feature1Desc') },
    { icon: Cloud, title: t('landing.feature2'), desc: t('landing.feature2Desc') },
    { icon: Zap, title: t('landing.feature3'), desc: t('landing.feature3Desc') },
    { icon: Link2, title: t('landing.feature4'), desc: t('landing.feature4Desc') },
    { icon: Palette, title: t('landing.feature5'), desc: t('landing.feature5Desc') },
    { icon: Globe, title: t('landing.feature6'), desc: t('landing.feature6Desc') },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* 顶部导航 */}
      <header className="glass-surface glass-blur sticky top-0 z-30 border-b shadow-sm transition-shadow duration-300">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Logo size={26} siteLogo={site.siteLogo} siteTitle={site.siteTitle ?? 'Picumet'} />
          <div className="flex items-center gap-2">
            <Link to="/docs" className="hidden text-sm text-muted-foreground hover:text-foreground sm:block">
              {t('landing.viewDocs')}
            </Link>
            <ThemeToggle />
            <LanguageSwitcher />
            <Link to="/login">
              <Button variant="outline" size="sm">{t('common.login')}</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <div className="absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute left-1/2 top-0 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-gradient-to-b from-primary/15 via-primary/8 to-transparent blur-3xl" />
          <div className="absolute left-1/3 top-1/4 h-[300px] w-[400px] rounded-full bg-sky-500/10 blur-2xl" />
          <div className="grid-pattern radial-mask absolute inset-0" />
        </div>
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm font-medium text-primary shadow-sm backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/75 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {t('landing.badge')}
        </span>
        <h1 className="max-w-3xl bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          {t('landing.heroTitle')}
        </h1>
        <p className="mt-4 max-w-xl text-lg text-muted-foreground">{t('landing.heroSub')}</p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Link to="/login" className="w-full sm:w-auto">
            <Button size="lg" className="h-12 w-full px-8 shadow-lg shadow-primary/25">
              {t('landing.start')} <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link to="https://github.com" className="w-full sm:w-auto">
            <Button variant="outline" size="lg" className="h-12 w-full px-8">
              <Github className="h-4 w-4" /> GitHub
            </Button>
          </Link>
        </div>
      </section>

      {/* 特性 */}
      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="glass-surface glass-blur group relative overflow-hidden rounded-lg border p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:shadow-lg"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 transition-transform duration-300 group-hover:scale-110">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-10 text-center shadow-xl sm:p-12">
          <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
          <div className="absolute -bottom-20 -left-20 h-40 w-40 rounded-full bg-sky-500/10 blur-3xl" />
          <div className="relative">
            <div className="mb-4 flex justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                <Rocket className="h-7 w-7 text-primary" />
              </div>
            </div>
            <h2 className="text-2xl font-bold">{t('landing.ctaTitle')}</h2>
            <p className="mx-auto mt-2 max-w-md text-muted-foreground">{t('landing.ctaSub')}</p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/login" className="w-full sm:w-auto">
                <Button size="lg" className="h-12 w-full px-8 shadow-lg shadow-primary/25">
                  {t('landing.deploy')}
                </Button>
              </Link>
              <Button variant="outline" size="lg" className="h-12 w-full px-8 sm:w-auto">
                <BookOpen className="h-4 w-4" /> {t('landing.viewDocs')}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t bg-muted/30 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <Logo size={20} />
            <span>© {new Date().getFullYear()} Picumet</span>
          </div>
          <div className="flex items-center gap-5">
            <a href="https://github.com" className="transition-colors hover:text-foreground">GitHub</a>
            <span className="text-border">·</span>
            <a href="/docs" className="transition-colors hover:text-foreground">{t('landing.viewDocs')}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
