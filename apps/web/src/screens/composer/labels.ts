import type { ModelProfileOption } from '../../api/composer';

/** One line per model choice: name, provider/model, default marks, pricing, machine count. */
export function modelLabel(p: ModelProfileOption): string {
  const price =
    p.pricing?.inputPerMTok === undefined && p.pricing?.outputPerMTok === undefined
      ? ''
      : ` · $${String(p.pricing.inputPerMTok ?? '–')}/$${String(p.pricing.outputPerMTok ?? '–')} per M`;
  const def = p.projectDefault ? ' (project default)' : p.isDefault ? ' (default)' : '';
  const n = p.workers.length;
  return `${p.displayName ?? p.name} — ${p.provider}/${p.model}${def}${price} · ${String(n)} machine${n === 1 ? '' : 's'}`;
}
