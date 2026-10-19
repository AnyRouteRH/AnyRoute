'use client';
import { useEffect, useState } from 'react';
import { browserPlatform, shortcutLabel } from '../../lib/keyboard-shortcuts';

export function useShortcutLabel(id) {
  const [platform, setPlatform] = useState('');
  useEffect(() => setPlatform(browserPlatform()), []);
  return shortcutLabel(id, platform);
}

export default function ShortcutKeys({ id }) {
  return <kbd>{useShortcutLabel(id)}</kbd>;
}
