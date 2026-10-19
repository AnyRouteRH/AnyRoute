'use client';
import { useEffect } from 'react';
import { applyChatShortcutAttributes } from '../../lib/keyboard-shortcuts';

export default function useChatShortcutAttributes() {
  useEffect(() => { applyChatShortcutAttributes(document); });
}
