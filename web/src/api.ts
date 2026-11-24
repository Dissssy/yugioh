import { useQuery } from '@tanstack/react-query';
import type { BanlistDetail, BanlistSummary, DeckSummary, DuelSummary, Me, OpenGames } from '@yugioh/shared';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`Request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });

/**
 * The decks the viewer may pick: premade and their own. Each deck's problems are under its own banlist, or under the
 * given banlist or duel's banlist when picking a deck for a duel.
 */
export const useDecks = (check: { banlist?: number; duel?: string } = {}) =>
  useQuery({
    queryKey: ['decks', check],
    queryFn: () => api<DeckSummary[]>(`/decks?${new URLSearchParams(Object.entries(check).map(([k, v]) => [k, String(v)]))}`),
  });
export const useBanlists = () => useQuery({ queryKey: ['banlists'], queryFn: () => api<BanlistSummary[]>('/banlists') });
export const useBanlist = (id: number | null) =>
  useQuery({ queryKey: ['banlist', id], queryFn: () => api<BanlistDetail>(`/banlists/${id}`), enabled: id !== null });
export const useDuels = () => useQuery({ queryKey: ['duels'], queryFn: () => api<DuelSummary[]>('/duels') });
/** The open games where the Discord Activity was opened (docs/discord.md), kept fresh while the page is open. */
export const useOpenGames = () => useQuery({ queryKey: ['open-games'], queryFn: () => api<OpenGames>('/open-games'), refetchInterval: 5000 });

/** The error message the server gave, or a generic one. */
export function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { error?: string } | null) : null;
  return body?.error ?? 'Something went wrong. Try again.';
}

/** Logging in brings the visitor back to the page they were on, such as a challenge link. */
export const loginHref = (returnTo: string) => `/login?returnTo=${encodeURIComponent(returnTo)}`;

/** Whether this server can log people in with Discord (docs/discord.md). */
export const useDiscordLogin = () =>
  useQuery({ queryKey: ['discord'], queryFn: () => api<{ clientId: string }>('/discord').then(() => true, () => false), staleTime: Infinity });
