import { Link, Route, Routes } from 'react-router';
import { useMe } from './api.ts';
import { Admin } from './pages/Admin.tsx';
import { Home } from './pages/Home.tsx';
import { Join } from './pages/Join.tsx';

export function App() {
  const me = useMe();
  const user = me.data?.kind === 'user' ? me.data.user : null;

  return (
    <>
      <header>
        <Link to="/" className="brand">Yu-Gi-Oh Duels</Link>
        <nav>
          {user?.isAdmin && <Link to="/admin">Accounts</Link>}
          {user ? (
            <a href="/auth/logout">Log out</a>
          ) : (
            <a href="/auth/login">Log in</a>
          )}
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
            <Route path="/join/:token" element={<Join me={me.data} />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        )}
      </main>
    </>
  );
}
