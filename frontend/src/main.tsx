import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './lib/i18n';
// 外观设置（明暗/壁纸/模糊/动画档位）在模块装载时就 applyTheme：认证检查或路由懒加载期间
// 渲染的 AppSkeleton 也要长在用户自己的壁纸与玻璃观感上（否则等出来的是无背景图无模糊的实底）
import './stores/theme';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
