import { describe, expect, it } from 'vitest';
import { type ExportDoc, exportMarkdown } from '../../src/chat/export.js';
import { safeMarkdown, safeMarkdownLine } from '../../src/chat/markdown-safe.js';

describe('Markdown export hardening (chat export)', () => {
  it('escapes raw HTML outside code', () => {
    expect(safeMarkdown('hi <img src=x onerror=alert(1)> and <script>x</script>')).toBe(
      'hi &lt;img src=x onerror=alert(1)> and &lt;script>x&lt;/script>',
    );
    expect(safeMarkdown('<details open>\n<summary>x</summary>\n</details>')).not.toContain('<');
    expect(safeMarkdown('autolink <javascript:alert(1)>')).toBe('autolink &lt;javascript:alert(1)>');
  });

  it('defuses script links and reference definitions; keeps http(s), mailto and relative links', () => {
    expect(safeMarkdown('[click](javascript:alert(1))')).toBe('[click]\\(javascript:alert(1))');
    expect(safeMarkdown('[c]( JavaScript:alert(1))')).toBe('[c]\\( JavaScript:alert(1))');
    expect(safeMarkdown('![i](data:text/html;base64,PHNjcmlwdD4=)')).toBe(
      '![i]\\(data:text/html;base64,PHNjcmlwdD4=)',
    );
    expect(safeMarkdown('[e](javascript&#58;alert(1))')).toBe('[e]\\(javascript&#58;alert(1))');
    expect(safeMarkdown('[e](jav&#9;ascript:alert(1))')).toBe('[e]\\(jav&#9;ascript:alert(1))');
    expect(safeMarkdown('[b](<javascript:alert(1)>)')).toBe('[b]\\(&lt;javascript:alert(1)>)');
    expect(safeMarkdown('[r]: javascript:alert(1)\n\n[x][r]')).toBe('\\[r]: javascript:alert(1)\n\n[x][r]');
    expect(safeMarkdown('[ok](https://example.com/a) [m](mailto:a@b.c) [rel](docs/a.md) [h](#x)')).toBe(
      '[ok](https://example.com/a) [m](mailto:a@b.c) [rel](docs/a.md) [h](#x)',
    );
  });

  it('keeps fenced code blocks and inline code byte for byte', () => {
    const code = 'Run:\n\n```html\n<b>bold</b> [x](javascript:y)\n```\n\nthen `a < b` and ``x ` <i>``.';
    expect(safeMarkdown(code)).toBe(
      'Run:\n\n```html\n<b>bold</b> [x](javascript:y)\n```\n\nthen `a < b` and ``x ` <i>``.',
    );
    expect(safeMarkdown('~~~\n<i>\n~~~~\n<b>')).toBe('~~~\n<i>\n~~~~\n&lt;b>');
  });

  it('closes a fence the message leaves open (later text cannot flip in or out of code)', () => {
    expect(safeMarkdown('```\n<i>')).toBe('```\n<i>\n```');
    expect(safeMarkdown('````\n```\n<i>')).toBe('````\n```\n<i>\n````');
  });

  it('does not take look-alikes for code', () => {
    // A backtick fence whose info string has a backtick is no fence; an escaped backtick opens no span.
    expect(safeMarkdown('```a`b\n<i>')).toBe('```a`b\n&lt;i>');
    expect(safeMarkdown('\\`<i>`')).toBe('\\`&lt;i>`');
    // A code span does not run across a blank line; an unmatched run is literal.
    expect(safeMarkdown('`a\n\n<i>`')).toBe('`a\n\n&lt;i>`');
    expect(safeMarkdown('``a` <i>')).toBe('``a` &lt;i>');
    // Four spaces: indented text or code — escaped either way.
    expect(safeMarkdown('    ```\n<i>')).toBe('    ```\n&lt;i>');
  });

  it('one-line values lose their newlines and are escaped the same way', () => {
    expect(safeMarkdownLine('a\n<b>\n[x](javascript:y)')).toBe('a &lt;b> [x]\\(javascript:y)');
  });
});

describe('exportMarkdown uses it', () => {
  it('message text, titles and card links', () => {
    const doc: ExportDoc = {
      version: 1,
      thread: { id: 't', title: 'T <b>', createdAt: 'x', updatedAt: 'y', owner: 'o' },
      exportedAt: '2026-10-12T00:00:00.000Z',
      exportedBy: 'o',
      access: 'owner',
      omittedVersions: 0,
      items: [
        {
          kind: 'message',
          role: 'assistant',
          author: 'a',
          at: '2026-10-12T00:00:00.000Z',
          text: 'see <img src=x onerror=alert(1)>\n\n```\n<kept>\n```',
          attachments: [],
          mentions: [],
          regenerated: null,
          edited: false,
        },
        {
          kind: 'card',
          at: '2026-10-12T00:00:00.000Z',
          cardKind: 'deploy',
          title: '<i>x</i>',
          state: 'done',
          decidedAt: null,
          links: [{ label: 'url', href: 'https://a.example/x)[y](javascript:z' }],
          restricted: false,
        },
      ],
    };
    const md = exportMarkdown(doc, 'en');
    expect(md).toContain('# T &lt;b>');
    expect(md).toContain('see &lt;img src=x onerror=alert(1)>');
    expect(md).toContain('```\n<kept>\n```');
    expect(md).toContain('**&lt;i>x&lt;/i>**');
    expect(md).toContain('[url](https://a.example/x%29[y]%28javascript:z)');
  });
});
