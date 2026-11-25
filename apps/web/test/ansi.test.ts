import { describe, expect, it } from 'vitest';
import { ANSI_CLASSES, applySgr, parseAnsi, PLAIN, splitSegments, stripAnsi } from '../src/lib/ansi';

const E = '\u001b';

function plain(text: string): string {
  return stripAnsi(text);
}

describe('ANSI parser (T-INJ-4)', () => {
  it('applies the SGR subset as classes', () => {
    const { segments } = parseAnsi(`a${E}[1;31mred${E}[0m b ${E}[92;44mhi${E}[39;49m!`);
    expect(segments).toEqual([
      { text: 'a', cls: '' },
      { text: 'red', cls: 'ansi-fg-1 ansi-b' },
      { text: ' b ', cls: '' },
      { text: 'hi', cls: 'ansi-fg-10 ansi-bg-4' },
      { text: '!', cls: '' },
    ]);
    for (const seg of segments) {
      for (const c of seg.cls.split(' ').filter(Boolean)) expect(ANSI_CLASSES).toContain(c);
    }
  });

  it('256 colours keep only the 16 base colours; true colour is dropped; state carries over', () => {
    expect(applySgr(PLAIN, '38;5;9').fg).toBe(9);
    expect(applySgr(PLAIN, '38;5;200').fg).toBeNull();
    expect(applySgr(PLAIN, '38;2;255;0;0;1')).toMatchObject({ fg: null, bold: true });
    expect(applySgr(PLAIN, '7;8;9;5')).toEqual(PLAIN); // inverse/conceal/strike/blink ignored
    const first = parseAnsi(`${E}[33mwarn`);
    const second = parseAnsi('ing', first.state);
    expect(second.segments).toEqual([{ text: 'ing', cls: 'ansi-fg-3' }]);
  });

  it('removes OSC 52 clipboard writes and OSC 8 hyperlinks (BEL and ST terminated)', () => {
    expect(plain(`x${E}]52;c;ZXZpbCBjb21tYW5k\u0007y`)).toBe('xy');
    expect(plain(`x${E}]52;c;ZXZpbA==${E}\\y`)).toBe('xy');
    expect(plain(`${E}]8;;https://evil.example/${E}\\click${E}]8;;${E}\\`)).toBe('click');
    expect(plain(`${E}]0;fake title\u0007ok`)).toBe('ok');
    expect(plain('a\u009d52;c;ZXZpbA==\u009cb')).toBe('ab');
  });

  it('removes cursor movement, erase, DEC private modes and other CSI', () => {
    expect(plain(`a${E}[2J${E}[H${E}[10;20Hb${E}[?1049h${E}[?2004hc${E}[1A${E}[Kd${E}[6n`)).toBe('abcd');
    // A private-parameter SGR-looking sequence is not applied.
    expect(parseAnsi(`${E}[?31mx`).segments).toEqual([{ text: 'x', cls: '' }]);
    // 8-bit CSI is never applied.
    expect(parseAnsi('\u009b31mx').segments).toEqual([{ text: 'x', cls: '' }]);
  });

  it('removes DCS/SOS/PM/APC strings, two-byte escapes, C0/C1 controls, DEL and bidi overrides', () => {
    expect(plain(`a${E}Pq#0;2;0;0;0${E}\\b${E}_apc${E}\\c${E}^pm${E}\\d${E}Xsos${E}\\e`)).toBe('abcde');
    expect(plain(`a${E}(Bb${E}7c${E}8d${E}=e`)).toBe('abcde');
    expect(plain('a\u0007b\u0008c\u0000d\u007fe\u0085f')).toBe('abcdef');
    expect(plain('safe‮txt.exe⁦x⁩')).toBe('safetxt.exex');
    expect(plain('tab\tkept\nnew')).toBe('tab\tkept\nnew');
    expect(plain('progress 10%\rprogress 20%\r\ndone')).toBe('progress 10%\nprogress 20%\ndone');
  });

  it('an unterminated sequence swallows the rest (no partial interpretation)', () => {
    expect(plain(`ok${E}]52;c;ZXZpbA==`)).toBe('ok');
    expect(plain(`ok${E}[31`)).toBe('ok');
    expect(plain(`ok${E}`)).toBe('ok');
    expect(plain(`ok${E}Pdata`)).toBe('ok');
  });

  it('keeps HTML as text (rendering escapes it)', () => {
    expect(plain('<script>alert(1)</script><img src=x onerror=alert(2)>')).toBe(
      '<script>alert(1)</script><img src=x onerror=alert(2)>',
    );
  });

  it('is linear on hostile input', () => {
    const hostile = `${E}[`.repeat(50_000) + `${E}]`.repeat(50_000) + 'x';
    const t = performance.now();
    plain(hostile);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('splits segments into lines', () => {
    const { segments } = parseAnsi(`a${E}[31mb\nc${E}[0m\n\nd`);
    expect(splitSegments(segments)).toEqual([
      [
        { text: 'a', cls: '' },
        { text: 'b', cls: 'ansi-fg-1' },
      ],
      [{ text: 'c', cls: 'ansi-fg-1' }],
      [],
      [{ text: 'd', cls: '' }],
    ]);
  });
});
