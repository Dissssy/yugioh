import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import { errorText } from './api.ts';
import { inActivity, startActivity } from './discord.ts';
import { Loading, Notice } from './pages/Notice.tsx';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById('root')!);

if (inActivity) {
  root.render(
    <main>
      <Loading />
    </main>,
  );
  try {
    await startActivity();
  } catch (error) {
    console.error('Discord sign-in failed:', error);
    root.render(
      <main>
        <Notice title="Couldn't sign you in with Discord" tone="error">
          {errorText(error)}
        </Notice>
      </main>,
    );
    throw error;
  }
}

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
