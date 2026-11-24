import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { User } from '@yugioh/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { inActivity } from './discord.ts';

/** The account's name in the top bar, opening a menu with the account page and logging out. */
export function AccountMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context, { role: 'menu' })]);
  const close = () => setOpen(false);

  return (
    <>
      <button ref={refs.setReference} className="who" {...getReferenceProps()}>
        <Avatar name={user.username} />
        {user.username}
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <FloatingFocusManager context={context} modal={false}>
          <div ref={refs.setFloating} style={floatingStyles} className="account-menu" {...getFloatingProps()}>
            <div className="account-menu-head">
              <strong>{user.username}</strong>
              {user.status !== 'approved' && <span className="muted small">{user.status === 'pending' ? 'Waiting for approval' : 'Not approved'}</span>}
            </div>
            {user.status === 'approved' && <Link role="menuitem" to="/decks" onClick={close}>Decks and banlists</Link>}
            <Link role="menuitem" to="/account" onClick={close}>Account and settings</Link>
            {/* In the Discord Activity, Discord is the login: closing the Activity is logging out. */}
            {!inActivity && <a role="menuitem" href="/auth/logout">Log out</a>}
          </div>
        </FloatingFocusManager>
      )}
    </>
  );
}

export const Avatar = ({ name }: { name: string }) => <span className="avatar" aria-hidden>{name[0]!.toUpperCase()}</span>;
