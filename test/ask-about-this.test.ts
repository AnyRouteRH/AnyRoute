import { describe, expect, test } from 'bun:test';
import { insertQuote, quoteSelection, selectedReply } from '../web/lib/ask-about-this.js';
import { askAboutThisBrowser } from '../src/privacy/ask-about-this';

describe('H175 browser quotes', () => {
  test('formats multiline and code selections without uploading or parsing them', () => {
    expect(quoteSelection('line\n\n  const value = 1;')).toBe('> line\n> \n>   const value = 1;');
    expect(insertQuote('Follow up', 'answer', 0)).toEqual({ text: '> answer\n\nFollow up', cursor: 10 });
  });
  test('caps selections including an ellipsis and is off without a valid selection', () => {
    expect(quoteSelection('x'.repeat(1501))).toBe('> ' + 'x'.repeat(1499) + '…');
    expect(selectedReply(null, null)).toBeNull();
  });
  test('inventory discloses ordinary message handling and router memory access', () => {
    expect(askAboutThisBrowser.holds).toContain('router reads ordinary inference text in memory');
    expect(askAboutThisBrowser.holds).toContain('no new storage key');
  });
});
