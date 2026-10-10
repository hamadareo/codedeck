/**
 * Command palette matching (§4). Case- and width-insensitive; every query
 * character must appear in order. Contiguous runs and word starts score higher.
 */

export interface PaletteItem {
  id: string;
  group: 'session' | 'project' | 'profile' | 'command' | 'setting';
  label: string;
  /** Extra text matched but shown smaller (profile name, path ...). */
  detail?: string;
  keywords?: string;
}

/** Fold case and full-width ASCII (Ｔ → t) so Japanese IME input still matches. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000)
      out += ' '; // ideographic space
    else out += ch;
  }
  return out.toLowerCase();
}

/** Score of `query` against `text`; null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query).replace(/\s+/g, '');
  if (!q) return 0;
  const t = fold(text);
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 8 : 1;
    if (found === 0 || /[\s/\\\-_.#]/.test(t[found - 1] ?? '')) score += 5;
    prev = found;
    ti = found + 1;
  }
  return score;
}

const GROUP_ORDER: PaletteItem['group'][] = ['session', 'command', 'project', 'profile', 'setting'];

export function filterPalette(items: PaletteItem[], query: string, limit = 50): PaletteItem[] {
  if (!query.trim()) {
    return [...items]
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
      .slice(0, limit);
  }
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    // A label match always outranks a match that needs the detail/keywords.
    const onLabel = fuzzyScore(query, item.label);
    const onAll = onLabel ?? fuzzyScore(query, `${item.label} ${item.detail ?? ''} ${item.keywords ?? ''}`);
    if (onLabel !== null) scored.push({ item, score: onLabel + 10_000 });
    else if (onAll !== null) scored.push({ item, score: onAll });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((x) => x.item);
}
