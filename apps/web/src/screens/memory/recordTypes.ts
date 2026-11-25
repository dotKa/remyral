import { type RecordType } from '../../api/memoryRecords';

/** The types an untyped document can get: instructions only become a rule; memory a fact, decision or lesson. */
export function typesFor(kind: string): readonly RecordType[] {
  return kind === 'instructions' ? ['rule'] : ['fact', 'decision', 'lesson'];
}
