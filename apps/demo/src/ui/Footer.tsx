import type { ReactNode } from 'react';

export function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="foot">
      {children && <p>{children}</p>}
      <p>
        lunchrush is a learning project inspired by Ditto’s offline-first sync. It is not a Ditto product and
        uses no Ditto code. <a href="https://github.com/abishekprabakar/lunchrush">Source and write-up on GitHub</a>.
      </p>
    </footer>
  );
}
