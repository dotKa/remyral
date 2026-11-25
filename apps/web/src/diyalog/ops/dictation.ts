import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §5): dictation in the composer over the browser's own
 * SpeechRecognition (Chrome / Edge: `webkitSpeechRecognition`, Safari, newer: `SpeechRecognition`). The console never
 * receives audio: the browser's engine turns speech into text (Chrome sends the audio to its own speech service).
 * Interim text is shown live in the field; final text is kept; Stop ends it. Where the API is missing the composer
 * shows no microphone button.
 */

interface RecognitionAlternative {
  readonly transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative | undefined;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult | undefined };
}

/** The part of the Web Speech API the composer uses. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

/** The browser's recognition constructor, or null where dictation is not supported. */
export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type DictationError = 'denied' | 'failed';

export function useDictation(opts: {
  /** BCP 47 tag from the console language (`tr-TR`, `en-US`). */
  readonly lang: string;
  /** The field's text when dictation starts (what is said is appended to it). */
  readonly base: () => string;
  readonly onText: (text: string) => void;
}): {
  readonly supported: boolean;
  readonly listening: boolean;
  readonly error: { readonly kind: DictationError; readonly code: string } | null;
  readonly start: () => void;
  readonly stop: () => void;
} {
  const [supported] = useState(() => speechRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<{ kind: DictationError; code: string } | null>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (Ctor === null || rec.current !== null) return;
    const r = new Ctor();
    r.lang = optsRef.current.lang;
    r.continuous = true;
    r.interimResults = true;
    const base = optsRef.current.base();
    const sep = base === '' || /\s$/.test(base) ? '' : ' ';
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const said = res?.[0]?.transcript ?? '';
        if (res?.isFinal === true) finalText += said;
        else interim += said;
      }
      optsRef.current.onText(`${base}${sep}${finalText}${interim}`);
    };
    r.onerror = (e) => {
      // Silence and a stop are not errors.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      setError({
        kind: e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : 'failed',
        code: e.error.slice(0, 40),
      });
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      // The interim words are dropped once nothing more comes: what stays is what the engine finalised.
      optsRef.current.onText(`${base}${finalText === '' ? '' : sep}${finalText}`);
    };
    rec.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      setError({ kind: 'failed', code: 'start' });
    }
  }, []);

  useEffect(
    () => () => {
      rec.current?.abort();
      rec.current = null;
    },
    [],
  );

  return { supported, listening, error, start, stop };
}
