'use client';
// E149: reuse the caller context and the existing key form and card.
import { useContext, useState } from 'react';
import { KeyExpiryContext } from './useKeyExpiry';
import { READ_ONLY_LABEL, readScopeSelectable } from '../../lib/read-only-keys';
export function useReadOnlyKey(existing, live) {
  const caller = useContext(KeyExpiryContext);
  const [read, setRead] = useState(false);
  const allowed = live && !existing && readScopeSelectable(caller);
  return {
    fields: allowed && <label className="check-label"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)}/> {READ_ONLY_LABEL}</label>,
    wrapSave: save => values => save(allowed && read ? { ...values, scope: 'read' } : values),
  };
}
export function ReadOnlyKeyBadge({ value }) {
  return value === 'read' ? <span className="badge">Read only</span> : null;
}
