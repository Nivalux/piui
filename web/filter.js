/**
 * Typing at the sidebar: fzf-style subsequence matching.
 *
 * @typedef {{ score: number, ranges: [number, number][] }} Hit
 * @typedef {{ score: number, index: number, ranges: [number, number][] }} Best
 */

const word_start = /[\s/\-_.:,@]/;

/**
 * Score one field. Ranges are half-open `[from, to)` over `text`.
 *
 * @param {string} query
 * @param {string} text
 * @returns {Hit | null}
 */
export function fuzzyMatch(query, text) {
  const needle = String(query).trim().toLowerCase();
  const hay = String(text).toLowerCase();
  /** @type {[number, number][]} */
  const ranges = [];
  if (needle.length === 0) return { score: 0, ranges };

  let score = 0;
  let from = 0;
  let previous = -2;

  for (const character of needle) {
    const at = hay.indexOf(character, from);
    if (at < 0) return null;

    if (at === previous + 1) {
      score += 10;
    } else if (at === 0 || word_start.test(hay[at - 1])) {
      score += 7;
    } else {
      score += 1;
      score -= Math.min(3, at - previous - 2);
    }

    const last = ranges[ranges.length - 1];
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);

    previous = at;
    from = at + 1;
  }

  if (hay.includes(needle)) score += 25;
  score -= Math.min(12, ranges[0][0]);
  return { score, ranges };
}

/**
 * The strongest field for one item. Index 0 is the field the row shows, so only a hit there gets
 * highlighted.
 *
 * @param {string} query
 * @param {string[]} texts
 * @returns {Best | null}
 */
export function bestMatch(query, texts) {
  /** @type {Best | null} */
  let best = null;
  for (const [index, text] of texts.entries()) {
    const hit = fuzzyMatch(query, text);
    if (!hit) continue;
    if (best && best.score >= hit.score) continue;
    best = { score: hit.score, index, ranges: hit.ranges };
  }
  return best;
}

/**
 * Items a query reaches, best first. An empty query keeps the incoming order, which is the order
 * the caller chose (newest first).
 *
 * @template T
 * @param {string} query
 * @param {T[]} items
 * @param {(item: T) => string[]} texts fields to search; the first is displayed
 * @returns {{item: T, score: number, ranges: [number, number][]}[]}
 */
export function rank(query, items, texts) {
  const needle = String(query).trim();
  if (needle.length === 0) {
    return items.map((item) => ({ item, score: 0, ranges: /** @type {[number, number][]} */ ([]) }));
  }

  /** @type {{item: T, score: number, ranges: [number, number][]}[]} */
  const scored = [];
  for (const item of items) {
    const best = bestMatch(needle, texts(item));
    if (!best) continue;
    scored.push({ item, score: best.score, ranges: best.index === 0 ? best.ranges : [] });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Wrap the matched ranges of `text` for display. The whole word comes back as one node, because a
 * row that lays its parts out with a gap would otherwise put that gap between every letter.
 *
 * @param {string} text
 * @param {[number, number][]} ranges
 * @param {string} tag
 * @returns {HTMLElement | Text}
 */
export function highlight(text, ranges, tag = "i") {
  const value = String(text);
  if (ranges.length === 0) return document.createTextNode(value);

  const word = document.createElement("span");
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) word.append(document.createTextNode(value.slice(at, from)));
    const mark = document.createElement(tag);
    mark.textContent = value.slice(from, to);
    word.append(mark);
    at = to;
  }
  if (at < value.length) word.append(document.createTextNode(value.slice(at)));
  return word;
}
