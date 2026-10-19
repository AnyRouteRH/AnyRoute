// K191: optional metadata on the shown message version, in the existing history vault.
export function pinFields(message) {
  if (message?.pinned !== undefined && typeof message.pinned !== 'boolean') throw new Error('Choose a history export with valid message pins.');
  return message?.pinned === true ? { pinned: true } : {};
}

export function pinHistoryFields(message) {
  const fields = pinFields(message);
  if (fields.pinned && message.role === 'assistant' && message.status !== undefined) {
    if (!['waiting', 'streaming', 'done', 'stopped', 'error'].includes(message.status)) throw new Error('Choose a history export with a valid pinned reply status.');
    fields.status = ['waiting', 'streaming'].includes(message.status) ? 'stopped' : message.status;
  }
  return fields;
}

export const pinnedMessages = lane => (lane?.messages || []).filter(message => message.pinned === true && ['user', 'assistant'].includes(message.role));

export function toggleMessagePin(lane, messageId) {
  if (!lane.messages.some(message => message.id === messageId && ['user', 'assistant'].includes(message.role))) return lane;
  return { ...lane, messages: lane.messages.map(message => {
    if (message.id !== messageId) return message;
    const { pinned, ...rest } = message;
    return pinned === true ? rest : { ...rest, pinned: true };
  }) };
}

export const pinAnchor = (laneId, messageId) => `chat-message-${encodeURIComponent(JSON.stringify([laneId, messageId]))}`;
export function jumpToPinnedMessage(document, laneId, messageId) {
  const anchor = document.getElementById(pinAnchor(laneId, messageId));
  const target = anchor?.closest('article');
  if (!target) return false;
  target.tabIndex = -1;
  target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
  return true;
}

// Empty and failed pinned replies still have a place in history. Normal snapshots remain unchanged.
export function pinSnapshotSource(message) {
  return message.pinned === true && message.role === 'assistant' ? { ...message, status: 'done', text: message.text || ' ', toolCalls: [] } : message;
}
