import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractChatGPTThread } from '../../src/dom/extractChatGPTThread.js';

const buildDom = (html: string): Document => {
  const dom = new JSDOM(html);
  return dom.window.document;
};

describe('extractChatGPTThread', () => {
  it('captures user and assistant markdown content with timestamps', () => {
    const html = `
      <html>
        <head><title>Exploration</title></head>
        <body>
          <section data-testid="conversation-turn-user">
            <div data-testid="markdown">How do I merge threads?</div>
            <time datetime="2025-05-01T12:00:00Z">noon</time>
          </section>
          <section data-testid="conversation-turn-assistant">
            <div data-testid="markdown">Use a merge plan.</div>
          </section>
        </body>
      </html>
    `;

    const { title, messages } = extractChatGPTThread(buildDom(html));
    expect(title).toBe('Exploration');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'How do I merge threads?',
      timestamp: '2025-05-01T12:00:00Z',
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Use a merge plan.',
    });
  });

  it('falls back to combined text when markdown nodes are missing', () => {
    const html = `
      <html>
        <head><title>Edge Cases</title></head>
        <body>
          <div data-testid="conversation-turn-system">
            <p>System preface</p>
          </div>
          <div data-testid="conversation-turn-user">
            <pre>code block</pre>
          </div>
          <div data-testid="conversation-turn-assistant">
            <p>  Lots
                of   whitespace </p>
          </div>
        </body>
      </html>
    `;

    const { messages } = extractChatGPTThread(buildDom(html));
    expect(messages.map((msg) => msg.role)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
    expect(messages[0].content).toBe('System preface');
    expect(messages[1].content).toBe('code block');
    expect(messages[2].content).toBe('Lots of whitespace');
  });
});
