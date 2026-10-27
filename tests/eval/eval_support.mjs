import { createHash } from "node:crypto";
import { assertIndexContract } from "../../docs/src/search-config.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateIndex(manifest, meta, bytes) {
  assertIndexContract(manifest, meta.length);
  if (manifest.bytes !== bytes.byteLength ||
      manifest.metadata_sha256 !== hash(JSON.stringify(meta)) ||
      manifest.vectors_sha256 !== hash(bytes)) {
    throw new Error("Search index checksum mismatch; rebuild the index");
  }
}

export function compareBaseline(baseline, queries, metrics) {
  if (baseline.results.length !== queries.length || baseline.results.some((result, i) =>
    result.query !== queries[i].query ||
    JSON.stringify(result.expected) !== JSON.stringify(queries[i].expected))) {
    throw new Error("Evaluation queries changed; comparison with the captured baseline is invalid");
  }
  const delta = {};
  const regressions = [];
  for (const key of ["recall1", "recall8", "mrr", "visibleRecall8", "offTopicHits"]) {
    delta[key] = metrics[key] - baseline.metrics[key];
    if (key === "offTopicHits" ? delta[key] > 0 : delta[key] < -1e-12) regressions.push(key);
  }
  return { metrics: baseline.metrics, delta, regressions };
}

export function scoreCalibration(results, negatives) {
  const correct = results.map((result) => result.score).sort((a, b) => a - b);
  const negative = negatives.map((result) => result.score).sort((a, b) => a - b);
  if (!correct.length || !negative.length || ![...correct, ...negative].every(Number.isFinite)) {
    throw new Error("Calibration requires finite correct and negative scores");
  }
  const quantile = (scores, fraction) => scores[Math.floor((scores.length - 1) * fraction)];
  const negativeMax = negative.at(-1);
  const gap = correct[0] - negativeMax;
  const min = gap > 0 ? (correct[0] + negativeMax) / 2 : negativeMax + 0.001;
  const medium = Math.max(min, quantile(correct, 0.25));
  const high = Math.max(medium, quantile(correct, 0.75));
  return {
    correct: { min: correct[0], p10: quantile(correct, 0.1), p25: quantile(correct, 0.25),
      median: quantile(correct, 0.5), p75: quantile(correct, 0.75), max: correct.at(-1) },
    negatives: { count: negative.length, min: negative[0], median: quantile(negative, 0.5), max: negativeMax },
    separation: gap,
    recommendation: {
      scores: { min, medium, high },
      rationale: gap > 0 ? "Floor midway between maximum negative and minimum correct score"
        : "Scores overlap; floor above maximum negative trades recall for rejection",
      visibleRecall8: results.filter((result) => result.rank >= 1 && result.rank <= 8 && result.score >= min).length / results.length,
      offTopicHits: negative.filter((score) => score >= min).length,
    },
  };
}
