'use client';
// J176: reveal the existing editor when a status link opens a section inside it.
import { useEffect, useRef } from 'react';
export default function AgentStatusTarget({ id, section }) {
  const ref = useRef(null);
  useEffect(() => {
    const visit = () => {
      if (location.hash !== '#' + id || !ref.current) return;
      const anchor = ref.current;
      const editor = anchor.closest('details');
      if (editor) editor.open = true;
      const scope = section === 'guard' ? anchor.closest('form') : section === 'stop' ? anchor.closest('section') : section === 'quiet' ? anchor.parentElement : anchor.nextElementSibling;
      const group = section === 'guard' || section === 'stop'
        ? [...(scope?.querySelectorAll('fieldset') ?? [])].find(field => field.querySelector('legend')?.textContent.includes(section === 'guard' ? 'Agent Guard' : 'Stop')) : scope;
      const focus = group?.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? anchor;
      focus.scrollIntoView({ block: 'center' }); focus.focus({ preventScroll: true });
    };
    visit(); window.addEventListener('hashchange', visit);
    return () => window.removeEventListener('hashchange', visit);
  }, [id, section]);
  return <span id={id} ref={ref} tabIndex={-1}/>;
}
