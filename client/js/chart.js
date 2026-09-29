/**
 * CheckYourMorpho: Monte Carlo Canvas 2D Simulator & Renderer
 * Runs 1,000 paths client-side in milliseconds and renders an interactive fan chart.
 */

export class MonteCarloChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.simulationData = null;
    this.initialDeposit = 10000;
    this.horizonDays = 30;
    this.annualApy = 0.045;
    this.volatility = 0.015;
    this.safetyScore = 80;

    this.mouseX = -1;
    this.hoverIndex = -1;

    this.resize();
    this.initEvents();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 600;
    this.height = rect.height || 220;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);

    if (this.simulationData) {
      this.render();
    }
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.render();
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouseX = -1;
      this.render();
    });
  }

  /**
   * Runs 1,000 Monte Carlo paths and computes quantiles.
   */
  simulate(params = {}) {
    this.initialDeposit = params.initialDeposit ?? this.initialDeposit;
    this.horizonDays = params.horizonDays ?? this.horizonDays;
    this.annualApy = params.annualApy ?? this.annualApy;
    this.safetyScore = params.safetyScore ?? this.safetyScore;

    // Calibrate volatility: lower safety score = higher tail risk & dispersion
    const riskFactor = Math.max(0.1, (100 - this.safetyScore) / 40);
    this.volatility = 0.005 + (riskFactor * 0.02);

    const numPaths = 1000;
    const steps = Math.min(60, this.horizonDays);
    const dt = this.horizonDays / steps;
    const dailyDrift = (this.annualApy / 365) * dt;
    const dailyVol = (this.volatility / Math.sqrt(365)) * Math.sqrt(dt);

    // Timeline array
    const timeline = [];
    for (let s = 0; s <= steps; s++) {
      timeline.push(Math.round(s * dt));
    }

    // Paths matrix: [step][pathIndex]
    const paths = Array.from({ length: steps + 1 }, () => new Float64Array(numPaths));

    // Step 0: all paths start at initial deposit
    for (let p = 0; p < numPaths; p++) {
      paths[0][p] = this.initialDeposit;
    }

    // Box-Muller standard normal generator
    let haveSpare = false;
    let spareRand = 0;
    const randNorm = () => {
      if (haveSpare) {
        haveSpare = false;
        return spareRand;
      }
      let u, v, s;
      do {
        u = Math.random() * 2 - 1;
        v = Math.random() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const mul = Math.sqrt(-2 * Math.log(s) / s);
      spareRand = v * mul;
      haveSpare = true;
      return u * mul;
    };

    // Simulate Geometric Brownian Motion with possible stress drawdowns for high risk
    const stressProb = (100 - this.safetyScore) / 4000; // e.g. 0.5% for D score

    for (let s = 1; s <= steps; s++) {
      for (let p = 0; p < numPaths; p++) {
        let prev = paths[s - 1][p];
        let shock = randNorm();

        // Occasional stress jumps for poor safety scores
        if (Math.random() < stressProb) {
          prev *= (1 - (0.02 + Math.random() * 0.05));
        }

        const change = prev * (dailyDrift + dailyVol * shock);
        paths[s][p] = Math.max(0, prev + change);
      }
    }

    // Compute percentiles for each step
    const p5 = new Float64Array(steps + 1);
    const p50 = new Float64Array(steps + 1);
    const p95 = new Float64Array(steps + 1);

    for (let s = 0; s <= steps; s++) {
      const sorted = Float64Array.from(paths[s]).sort();
      p5[s] = sorted[Math.floor(numPaths * 0.05)];
      p50[s] = sorted[Math.floor(numPaths * 0.50)];
      p95[s] = sorted[Math.floor(numPaths * 0.95)];
    }

    const minVal = Math.min(...p5) * 0.995;
    const maxVal = Math.max(...p95) * 1.005;

    this.simulationData = {
      timeline,
      steps,
      p5,
      p50,
      p95,
      minVal,
      maxVal,
      finalExpected: p50[steps],
      finalP5: p5[steps],
      finalP95: p95[steps]
    };

    this.render();
    return this.simulationData;
  }

  render() {
    if (!this.simulationData) return;

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    const padLeft = 65;
    const padRight = 20;
    const padTop = 15;
    const padBottom = 28;

    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    const { timeline, steps, p5, p50, p95, minVal, maxVal } = this.simulationData;

    const getX = (stepIndex) => padLeft + (stepIndex / steps) * chartW;
    const getY = (val) => padTop + chartH - ((val - minVal) / (maxVal - minVal || 1)) * chartH;

    // 1. Draw horizontal gridlines & Y-axis labels
    const numYLines = 4;
    ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= numYLines; i++) {
      const ratio = i / numYLines;
      const val = minVal + ratio * (maxVal - minVal);
      const y = padTop + chartH - ratio * chartH;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();

      ctx.fillStyle = '#666666';
      ctx.fillText(`$${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, padLeft - 8, y);
    }

    // 2. Draw X-axis labels (days)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xInterval = Math.max(1, Math.floor(steps / 4));
    for (let s = 0; s <= steps; s += xInterval) {
      const x = getX(s);
      ctx.fillStyle = '#666666';
      ctx.fillText(`${timeline[s]}d`, x, padTop + chartH + 8);
    }

    // 3. Draw shaded fan area between p5 and p95
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(p95[0]));
    for (let s = 1; s <= steps; s++) {
      ctx.lineTo(getX(s), getY(p95[s]));
    }
    for (let s = steps; s >= 0; s--) {
      ctx.lineTo(getX(s), getY(p5[s]));
    }
    ctx.closePath();

    const fanGrad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
    fanGrad.addColorStop(0, 'rgba(36, 112, 255, 0.16)');
    fanGrad.addColorStop(1, 'rgba(36, 112, 255, 0.03)');
    ctx.fillStyle = fanGrad;
    ctx.fill();

    // 4. Draw p95 Curve (Optimistic / Bull - Cyan)
    ctx.strokeStyle = '#5792ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const x = getX(s);
      const y = getY(p95[s]);
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 5. Draw p5 Curve (Pessimistic / Stress - Orange)
    ctx.strokeStyle = '#ff9f0a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const x = getX(s);
      const y = getY(p5[s]);
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 6. Draw p50 Median Line (Bright White with subtle shadow)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.0;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const x = getX(s);
      const y = getY(p50[s]);
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset

    // 7. End dots
    const lastX = getX(steps);
    const drawDot = (y, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lastX, y, 3, 0, Math.PI * 2);
      ctx.fill();
    };
    drawDot(getY(p95[steps]), '#5792ff');
    drawDot(getY(p50[steps]), '#ffffff');
    drawDot(getY(p5[steps]), '#ff9f0a');

    // 8. Interactive Hover Crosshair
    if (this.mouseX >= padLeft && this.mouseX <= padLeft + chartW) {
      const hoverRatio = (this.mouseX - padLeft) / chartW;
      const hoverStep = Math.min(steps, Math.max(0, Math.round(hoverRatio * steps)));
      const hoverX = getX(hoverStep);
      const day = timeline[hoverStep];
      const valP50 = p50[hoverStep];
      const valP95 = p95[hoverStep];
      const valP5 = p5[hoverStep];

      // Vertical guideline
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hoverX, padTop);
      ctx.lineTo(hoverX, padTop + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Highlight point on p50
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hoverX, getY(valP50), 4, 0, Math.PI * 2);
      ctx.fill();

      // Tooltip box
      const ttText = `Day ${day}: $${valP50.toFixed(2)} (p5: $${valP5.toFixed(0)} | p95: $${valP95.toFixed(0)})`;
      ctx.font = '11px "SF Mono", Menlo, monospace';
      const textW = ctx.measureText(ttText).width;
      const ttX = Math.min(w - padRight - textW - 12, Math.max(padLeft, hoverX - textW / 2));
      const ttY = Math.max(padTop + 4, getY(valP50) - 24);

      ctx.fillStyle = 'rgba(15, 15, 15, 0.9)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(ttX - 6, ttY - 14, textW + 12, 20, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(ttText, ttX, ttY - 4);
    }
  }
}
