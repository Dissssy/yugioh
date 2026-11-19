import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { loginHref, useMe } from './api.ts';
import { Admin } from './pages/Admin.tsx';
import { DeckPage } from './pages/DeckPage.tsx';
import { DuelPage } from './pages/DuelPage.tsx';
import { Home } from './pages/Home.tsx';
import { Loading, Notice } from './pages/Notice.tsx';

export function App() {
  const me = useMe();
  const user = me.data?.kind === 'user' ? me.data.user : null;
  const name = user?.username ?? (me.data?.kind === 'guest' ? me.data.guest.name : null);
  const location = useLocation();

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Yu-Gi-Oh Duels
        </Link>
        <nav>
          {user?.isAdmin && <NavLink to="/admin" className="nav-link">Admin</NavLink>}
          {name && (
            <span className="who">
              <span className="avatar" aria-hidden>{name[0]!.toUpperCase()}</span>
              {name}
              {me.data?.kind === 'guest' && <span className="tag">guest</span>}
            </span>
          )}
          {user ? (
            <a className="nav-link" href="/auth/logout">Log out</a>
          ) : (
            <a className="nav-link" href={loginHref(location.pathname)}>Log in</a>
          )}
        </nav>
      </header>
      <main>
        {me.isPending ? (
          <Loading />
        ) : me.isError ? (
          <Notice title="Can't reach the server" tone="error">Check your connection and reload the page.</Notice>
        ) : (
          <Routes>
            <Route path="/" element={<Home me={me.data} />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/duel/:id" element={<DuelPage me={me.data} />} />
            <Route path="/decks/:id" element={<DeckPage />} />
            <Route
              path="*"
              element={
                <Notice title="Page not found" action={<Link className="button primary" to="/">Back home</Link>}>
                  There's nothing at this address.
                </Notice>
              }
            />
          </Routes>
        )}
      </main>
    </>
  );
}
