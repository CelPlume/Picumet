// 落地页
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Cloud, Zap, Link2, Palette, Globe, ArrowRight, Github, BookOpen, Rocket } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/core';
import { ThemeToggle, LanguageSwitcher } from '@/components/layout/widgets';

export default function Landing() {
  const { t } = useTranslation();

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
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Logo size={26} />
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
          <div className="absolute left-1/2 top-0 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        </div>
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm text-muted-foreground">
          {t('landing.badge')}
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          {t('landing.heroTitle')}
        </h1>
        <p className="mt-4 max-w-xl text-lg text-muted-foreground">{t('landing.heroSub')}</p>
        <div className="mt-8 flex items-center gap-3">
          <Link to="/login">
            <Button size="lg">
              {t('landing.start')} <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link to="https://github.com">
            <Button variant="outline" size="lg">
              <Github className="h-4 w-4" /> GitHub
            </Button>
          </Link>
        </div>
      </section>

      {/* 特性 */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-lg border bg-card p-6 transition-shadow hover:shadow-md">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <f.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-10 text-center">
          <Rocket className="h-8 w-8 text-primary" />
          <h2 className="text-2xl font-bold">{t('landing.ctaTitle')}</h2>
          <p className="max-w-md text-muted-foreground">{t('landing.ctaSub')}</p>
          <div className="mt-2 flex items-center gap-3">
            <Link to="/login">
              <Button size="lg">{t('landing.deploy')}</Button>
            </Link>
            <Button variant="outline" size="lg">
              <BookOpen className="h-4 w-4" /> {t('landing.viewDocs')}
            </Button>
          </div>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t py-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Picumet</span>
          <div className="flex items-center gap-4">
            <a href="https://github.com" className="hover:text-foreground">GitHub</a>
            <a href="/docs" className="hover:text-foreground">{t('landing.viewDocs')}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
