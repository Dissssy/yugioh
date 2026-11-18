import { Link, Route, Routes, useLocation } from 'react-router';
import { loginHref, useMe } from './api.ts';
import { Admin } from './pages/Admin.tsx';
import { DeckPage } from './pages/DeckPage.tsx';
import { DuelPage } from './pages/DuelPage.tsx';
import { Home } from './pages/Home.tsx';

export function App() {
  const me = useMe();
  const user = me.data?.kind === 'user' ? me.data.user : null;
  const location = useLocation();

  return (
    <>
      <header>
        <Link to="/" className="brand">Yu-Gi-Oh Duels</Link>
        <nav>
          {user?.isAdmin && <Link to="/admin">Accounts</Link>}
          {me.data?.kind === 'guest' && <span className="muted">{me.data.guest.name} (guest)</span>}
          {user ? <a href="/auth/logout">Log out</a> : <a href={loginHref(location.pathname)}>Log in</a>}
        </nav>
      </header>
      <main>
        {me.isPending ? (
          <p>Loading…</p>
        ) : me.isError ? (
          <p className="error">Couldn't reach the server.</p>
        ) : (
          <Routes>
            <Route path="/" element={<Home me={me.data} />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/duel/:id" element={<DuelPage me={me.data} />} />
            <Route path="/decks/:id" element={<DeckPage />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        )}
      </main>
    </>
  );
}
