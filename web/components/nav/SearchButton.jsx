'use client';

export function openSiteSearch() {
  window.dispatchEvent(new Event('anyroute:site-search'));
}

// hint=false drops the ⌘K label (the Harness uses ⌘K to switch models); the button still opens search.
export default function SearchButton({ homepage = false, onOpen, hint = true }) {
  return <button type="button" className={homepage ? 'ar-button task-search' : 'site-search-button'} onClick={() => { onOpen?.(); openSiteSearch(); }} aria-haspopup="dialog" aria-controls="site-search">
    <span>{homepage ? 'Search everything' : 'Search'}</span>{!homepage && hint && <kbd aria-hidden="true">⌘K</kbd>}
  </button>;
}
