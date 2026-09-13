/**
 * Uniform spatial hash built with a counting sort. Rebuilt every frame, zero
 * allocation after construction. This is what keeps bullet-vs-red off O(n^2).
 */
export class Grid {
  cols = 1;
  rows = 1;
  originX = 0;
  originY = 0;

  private readonly cell: number;
  private readonly capacity: number;
  private counts: Int32Array;
  private cursor: Int32Array;
  private items: Int32Array;
  private cellOf: Int32Array;

  constructor(cell: number, capacity: number) {
    this.cell = cell;
    this.capacity = capacity;
    this.counts = new Int32Array(2);
    this.cursor = new Int32Array(1);
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    const n = this.cols * this.rows;
    if (this.counts.length < n + 1) {
      this.counts = new Int32Array(n + 1);
      this.cursor = new Int32Array(n);
    }
  }

  rebuild(n: number, xs: Float32Array, ys: Float32Array, originX: number, originY: number): void {
    this.originX = originX;
    this.originY = originY;
    const { cols, rows, cell } = this;
    const cellCount = cols * rows;
    const counts = this.counts;
    counts.fill(0, 0, cellCount + 1);

    const count = Math.min(n, this.capacity);
    for (let i = 0; i < count; i++) {
      let cx = ((xs[i] - originX) / cell) | 0;
      let cy = ((ys[i] - originY) / cell) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const c = cy * cols + cx;
      this.cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    this.cursor.set(counts.subarray(0, cellCount));
    for (let i = 0; i < count; i++) {
      const c = this.cellOf[i];
      this.items[this.cursor[c]++] = i;
    }
  }

  /** Fills `out` with candidate indices near (x, y) within radius r. Returns how many. */
  query(x: number, y: number, r: number, out: Int32Array): number {
    const { cols, rows, cell, originX, originY, counts, items } = this;
    let x0 = ((x - r - originX) / cell) | 0;
    let x1 = ((x + r - originX) / cell) | 0;
    let y0 = ((y - r - originY) / cell) | 0;
    let y1 = ((y + r - originY) / cell) | 0;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= cols) x1 = cols - 1;
    if (y1 >= rows) y1 = rows - 1;

    let n = 0;
    const cap = out.length;
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * cols;
      for (let cx = x0; cx <= x1; cx++) {
        const c = row + cx;
        const start = counts[c];
        const end = counts[c + 1];
        for (let k = start; k < end && n < cap; k++) out[n++] = items[k];
      }
    }
    return n;
  }
}
