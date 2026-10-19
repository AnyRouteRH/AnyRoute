'use client';
import { shortcutAria } from '../../lib/keyboard-shortcuts'; // K193
import ShortcutKeys from '../shortcuts/ShortcutKeys'; // K193

export function openSiteSearch() {
  window.dispatchEvent(new Event('anyroute:site-search'));
}

// The hint is optional; both keys open the same existing search dialog.
export default function SearchButton({ homepage = false, onOpen, hint = true }) {
  return <button type="button" className={homepage ? 'ar-button task-search' : 'site-search-button'} onClick={() => { onOpen?.(); openSiteSearch(); }} aria-haspopup="dialog" aria-controls="site-search" aria-keyshortcuts={[shortcutAria('site-search'), shortcutAria('focus-search')].join(' ')}>
    <span>{homepage ? 'Search everything' : 'Search'}</span>{!homepage && hint && <ShortcutKeys id="site-search"/>}
  </button>;
}
