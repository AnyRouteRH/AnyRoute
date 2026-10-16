'use client';
// J181: only transient model ids and availability leave the Chat component.
import { useEffect, useRef } from 'react';
import { registerCommand } from '../../lib/command-palette.js';
import { canContinue } from '../../lib/harness-continue.js';
import usePageCommand from './usePageCommand';
export default function ChatCommands({ lanes, focus, busy, continueReply }) {
  const lane = lanes[focus] || lanes[0], reply = lane?.messages.at(-1);
  const models = [...new Set(lanes.map(row => row.modelId).filter(Boolean))].slice(0, 2).join('\n');
  const recent = useRef([]);
  useEffect(() => {
    recent.current = [...new Set([...(models ? models.split('\n') : []), ...recent.current])].slice(0, 2);
    return registerCommand('chat-context', () => {}, { models: recent.current });
  }, [models]);
  usePageCommand('continue-answer', () => continueReply(lane.id, reply.id), !busy && canContinue(reply));
  return null;
}
