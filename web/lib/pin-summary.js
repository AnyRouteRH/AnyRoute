import { pinnedMessages } from './message-pins.js';

// K191: remove only unpinned complete turns. Tool replies stay beside their original calls.
export function pinnedSummaryRequest(model, messages, system, { maxTokens, prompt, contextMeter, buildRequest, defaultSettings }) {
  const turns = [];
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push([]);
    turns.at(-1).push(message);
  }
  let omitted = 0;
  const kept = () => turns.flat();
  const budget = () => contextMeter({ model, messages: [...kept().map(message => ({ ...message, contextSystem: undefined })), prompt], system }).tokens + maxTokens;
  while (budget() >= model.context) {
    const index = turns.findIndex(turn => !pinnedMessages({ messages: turn }).length);
    if (index < 0) throw new Error('Pinned messages need more room to summarize. Unpin a message or choose a model with more room.');
    omitted += turns[index].length;
    turns.splice(index, 1);
  }
  const { body, error } = buildRequest({ model, messages: [...kept(), prompt], system, settings: { ...defaultSettings(), maxTokens } });
  if (error) throw new Error(error);
  return { body, omitted };
}

export function keepSummaryPins(seed, lane) {
  // Requests must not replay dangling tool calls from the previous conversation.
  const pins = pinnedMessages(lane).map(({ toolCalls, contextSystem, ...message }) => ({ ...message }));
  if (pins.length) seed.messages.push(...pins);
  return seed;
}
