import { defaultSettings, normalizeModel } from '../lib/harness.js';

export const model = normalizeModel({ id: 'sample/text-vision', name: 'Text and vision', architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] }, supported_parameters: ['temperature', 'max_tokens', 'tools', 'tool_choice', 'response_format', 'seed', 'stop'] });
export const conversation = {
  model,
  settings: { ...defaultSettings(), temperature: 0, maxTokens: 64, seed: 7, format: 'json' },
  system: 'Be brief.',
  messages: [
    { role: 'user', text: 'Explain "it’s fine".\nThen say hello.' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"topic":"hello"}' }] },
    { role: 'tool', toolCallId: 'call-1', text: 'Hello 🌍' },
    { role: 'assistant', text: 'It means everything is okay.' },
    { role: 'user', text: 'What about these?', attachments: [{ kind: 'image', url: 'data:image/jpeg;base64,IMAGE_BYTES' }, { kind: 'image', url: 'data:image/png;base64,OTHER_IMAGE_BYTES' }, { kind: 'file', name: 'notes.pdf', url: 'data:application/pdf;base64,FILE_BYTES' }] },
  ],
  headers: { 'x-title': 'Anyroute Harness', 'x-anyroute-lane': 'attested', 'X-Anyroute-Decision-Tag': 'sha256:decision-hash' },
};
