// Colored Unicode Braille 2x4 subpixel graph renderer
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  // =========================================================================
  // 6. COLORED UNICODE BRAILLE GRAPH RENDERER (2x4 Subpixel Canvas)
  // =========================================================================
  const BRAILLE_BITS = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80]
  ];

  function renderBrailleGraph(preEl, axisEl, series, opts = {}) {
    if (!preEl || !axisEl) return;
    const rect = preEl.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 16) return;

    const charW = 7.8;
    const charH = 13.7;
    const cols = Math.max(16, Math.min(114, Math.floor(rect.width / charW)));
    const rows = Math.max(4, Math.min(18, Math.floor(rect.height / charH)));

    const pixW = cols * 2;
    const pixH = rows * 4;

    const data = series.slice(-pixW);
    if (data.length === 0) {
      preEl.textContent = '';
      return;
    }

    let minVal = opts.minVal !== undefined ? opts.minVal : Math.min(...data);
    let maxVal = opts.maxVal !== undefined ? opts.maxVal : Math.max(...data);
    if (opts.baseline !== undefined && opts.baseline !== null && isFinite(opts.baseline)) {
      minVal = Math.min(minVal, opts.baseline);
      maxVal = Math.max(maxVal, opts.baseline);
    }
    const pad = Math.max((maxVal - minVal) * 0.14, opts.minSpan || 0.15);
    const lo = Math.max(0, minVal - pad * 0.5);
    const hi = maxVal + pad;
    const span = Math.max(1e-6, hi - lo);

    const fmtAx = opts.fmtAxis || (v => v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2)));
    axisEl.innerHTML = `<span>${fmtAx(hi)}</span><span>${fmtAx((hi + lo) / 2)}</span><span>${fmtAx(lo)}</span>`;

    const grid = Array.from({ length: rows }, () => new Uint8Array(cols));
    const baseGrid = Array.from({ length: rows }, () => new Uint8Array(cols));

    const setPix = (target, px, py) => {
      if (px < 0 || px >= pixW || py < 0 || py >= pixH) return;
      const cx = px >> 1;
      const cy = py >> 2;
      target[cy][cx] |= BRAILLE_BITS[py & 3][px & 1];
    };

    if (opts.baseline !== undefined && opts.baseline !== null && isFinite(opts.baseline)) {
      const by = Math.round((1 - (opts.baseline - lo) / span) * (pixH - 1));
      for (let x = 0; x < pixW; x += 4) {
        setPix(baseGrid, x, by);
      }
    }

    const xOffset = pixW - data.length;
    let prevX = -1, prevY = -1;
    for (let i = 0; i < data.length; i++) {
      const px = xOffset + i;
      const norm = Math.max(0, Math.min(1, (data[i] - lo) / span));
      const py = Math.round((1 - norm) * (pixH - 1));
      setPix(grid, px, py);
      if (prevX >= 0) {
        const steps = Math.max(Math.abs(px - prevX), Math.abs(py - prevY));
        for (let s = 1; s <= steps; s++) {
          const ix = Math.round(prevX + (px - prevX) * (s / steps));
          const iy = Math.round(prevY + (py - prevY) * (s / steps));
          setPix(grid, ix, iy);
        }
      }
      prevX = px;
      prevY = py;
    }

    const seriesColor = opts.color || 'var(--cyan)';
    const lines = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const m = grid[r][c];
        const b = baseGrid[r][c];
        if (m) {
          line += `<span style="color:${seriesColor}">${String.fromCharCode(0x2800 + (m | b))}</span>`;
        } else if (b) {
          line += `<span style="color:var(--fg-muted)">${String.fromCharCode(0x2800 + b)}</span>`;
        } else {
          line += '\u2800';
        }
      }
      lines.push(line);
    }
    preEl.innerHTML = lines.join('\n');
  }

  Object.assign(Z, { BRAILLE_BITS, renderBrailleGraph });
})();
