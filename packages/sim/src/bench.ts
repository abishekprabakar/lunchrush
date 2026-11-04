/**
 * Runs the lunch-rush outage for every engine and several seeds, prints the
 * results, saves them to results.md at the repository root, and refreshes the
 * generated summaries in README.md and EXPLAINER.md.
 *
 *   pnpm bench
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ENGINE_KINDS } from './engines';
import { LUNCH_RUSH, runLunchRush, type LunchRushResult } from './lunch-rush';
import { renderResults, renderSummary } from './report';

const SEEDS = [1, 2, 3, 4, 5];

const results: LunchRushResult[] = [];
for (const engine of ENGINE_KINDS) {
  for (const seed of SEEDS) {
    const started = performance.now();
    results.push(runLunchRush(engine, seed, LUNCH_RUSH));
    console.error(`${engine} seed ${seed}: ${((performance.now() - started) / 1000).toFixed(1)} s of real time`);
  }
}

const root = new URL('../../../', import.meta.url);
const markdown = renderResults(results, LUNCH_RUSH, 'pnpm bench');
writeFileSync(new URL('results.md', root), markdown);
console.log(markdown);

// Paste the summary between the bench markers in the docs, so their numbers always come from this run.
const summary = renderSummary(results);
for (const doc of ['README.md', 'EXPLAINER.md']) {
  const file = new URL(doc, root);
  const text = readFileSync(file, 'utf8');
  const updated = text.replace(
    /<!-- bench:summary -->[\s\S]*?<!-- \/bench:summary -->/,
    `<!-- bench:summary -->\n${summary}\n<!-- /bench:summary -->`,
  );
  if (updated !== text) writeFileSync(file, updated);
}
console.error('\nSaved results.md and refreshed the summaries in README.md and EXPLAINER.md');
