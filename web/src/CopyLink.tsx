import { useEffect, useState } from 'react';
import { copyLink, siteLink } from './discord.ts';

/** A button that copies a link to a page of this site, `path` from the root, and says so for a moment. */
export function CopyLink({ path, label = 'Copy link', className = 'quiet' }: { path: string; label?: string; className?: string }) {
  const [done, setDone] = useState<'copied' | 'opened' | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 2000);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      className={className}
      title="Copy a link anyone can open"
      onClick={() => void copyLink(siteLink(path)).then((copied) => setDone(copied ? 'copied' : 'opened'))}
    >
      {done === 'copied' ? 'Link copied' : done === 'opened' ? 'Opened in your browser' : label}
    </button>
  );
}
