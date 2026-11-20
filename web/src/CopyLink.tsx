import { useEffect, useState } from 'react';

/** A button that copies a link to a page of this site, `path` from the root, and says so for a moment. */
export function CopyLink({ path, label = 'Copy link', className = 'quiet' }: { path: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      title="Copy a link anyone can open"
      onClick={() => void navigator.clipboard.writeText(new URL(path, window.location.origin).href).then(() => setCopied(true))}
    >
      {copied ? 'Link copied' : label}
    </button>
  );
}
