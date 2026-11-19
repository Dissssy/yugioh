import { useMutation, useQueryClient } from '@tanstack/react-query';
import { defaultSettings, type Me, type UserSettings } from '@yugioh/shared';
import { api, useMe } from './api.ts';

/** The viewer's account settings; guests and visitors get the defaults. */
export function useSettings(): UserSettings {
  const me = useMe();
  return me.data?.kind === 'user' ? me.data.settings : defaultSettings;
}

/** Saves a change to the account's settings, showing it at once and undoing it if the server refuses. */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  const setSettings = (settings: UserSettings | ((old: UserSettings) => UserSettings)) =>
    queryClient.setQueryData<Me>(['me'], (me) =>
      me?.kind === 'user' ? { ...me, settings: typeof settings === 'function' ? settings(me.settings) : settings } : me,
    );
  return useMutation({
    mutationFn: (change: Partial<UserSettings>) => api<UserSettings>('/me/settings', { method: 'PATCH', body: JSON.stringify(change) }),
    onMutate: (change) => {
      const me = queryClient.getQueryData<Me>(['me']);
      setSettings((old) => ({ ...old, ...change }));
      return me?.kind === 'user' ? me.settings : null;
    },
    onSuccess: (saved) => setSettings(saved),
    onError: (_error, _change, before) => before && setSettings(before),
  });
}
