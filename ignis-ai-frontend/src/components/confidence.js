// Turn a FIRMS confidence value into a representative integer percent.
export function confidenceToPercent(raw) {
  const viirsConfidence = { l: 25, n: 60, h: 90 };
  const category = String(raw).trim().toLowerCase();
  if (viirsConfidence[category] !== undefined) {
    return viirsConfidence[category];
  }

  const n = parseFloat(raw);
  if (isNaN(n)) return 0;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}
