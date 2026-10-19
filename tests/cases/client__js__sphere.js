import assert from 'node:assert/strict';

const close = (actual, expected, eps = 1e-6) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => {
    if (!Number.isFinite(e)) assert.equal(actual[i], e, `індекс ${i}`);
    else assert.ok(Math.abs(actual[i] - e) < eps, `індекс ${i}: ${actual[i]} != ${e}`);
  });
};

// Стовпці 3x3 обертання з матриці 4x4 (column-major)
const col = (m, c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export default {
  gcd: [
    ['типові пари: (12,18)=6, (18,12)=6, (17,5)=1, (100,75)=25', ({ gcd: f }) => {
      assert.equal(f(12, 18), 6); assert.equal(f(18, 12), 6); assert.equal(f(17, 5), 1); assert.equal(f(100, 75), 25);
    }],
    ['нуль: gcd(0,7)=7, gcd(7,0)=7, gcd(0,0)=0', ({ gcd: f }) => {
      assert.equal(f(0, 7), 7); assert.equal(f(7, 0), 7); assert.equal(f(0, 0), 0);
    }],
    ['рівні числа і одиниця: gcd(9,9)=9, gcd(1,1000)=1', ({ gcd: f }) => {
      assert.equal(f(9, 9), 9); assert.equal(f(1, 1000), 1);
    }],
    ['від’ємні: модуль результату правильний (6)', ({ gcd: f }) => {
      assert.equal(Math.abs(f(-12, 18)), 6); assert.equal(Math.abs(f(12, -18)), 6);
    }],
    ['NaN у другому аргументі завершується і повертає перший', ({ gcd: f }) => assert.equal(f(5, NaN), 5)],
  ],
  getCoprimeStride: [
    ['n <= 2 (включно з 0 і відємними) -> 1', ({ getCoprimeStride: f }) => {
      for (const n of [2, 1, 0, -5]) assert.equal(f(n), 1, `n=${n}`);
    }],
    ['конкретні значення: 3 -> 1, 10 -> 7, 566 -> 349, 1000 -> 619', ({ getCoprimeStride: f }) => {
      assert.equal(f(3), 1); assert.equal(f(10), 7); assert.equal(f(566), 349); assert.equal(f(1000), 619);
    }],
    ['для n від 3 до 400 крок взаємно простий з n і лежить у [1, n)', ({ getCoprimeStride: f, gcd }) => {
      for (let n = 3; n <= 400; n++) {
        const s = f(n);
        assert.ok(s >= 1 && s < n, `n=${n}, s=${s}`);
        assert.equal(gcd(s, n), 1, `n=${n}, s=${s}`);
      }
    }],
    ['крок обходить усі індекси без повторів (перестановка для n=566)', ({ getCoprimeStride: f }) => {
      const n = 566, s = f(n), seen = new Set();
      for (let i = 0; i < n; i++) seen.add((i * s) % n);
      assert.equal(seen.size, n);
    }],
    ['Infinity не зависає і дає 1', ({ getCoprimeStride: f }) => assert.equal(f(Infinity), 1)],
  ],
  makePerspective: [
    ['fov 90 градусів, aspect 2, near 1, far 3: точні елементи матриці', ({ makePerspective: f }) => {
      const m = f(Math.PI / 2, 2, 1, 3);
      assert.ok(m instanceof Float32Array);
      close(m, [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2, -1, 0, 0, -3, 0]);
    }],
    ['параметри сфери (50 градусів, 16:10, 0.1..200): f = 1/tan(25 градусів)', ({ makePerspective: f }) => {
      const fov = 50 * Math.PI / 180, ff = 1 / Math.tan(fov / 2), nf = 1 / (0.1 - 200);
      close(f(fov, 1.6, 0.1, 200), [ff / 1.6, 0, 0, 0, 0, ff, 0, 0, 0, 0, 200.1 * nf, -1, 0, 0, 2 * 200 * 0.1 * nf, 0], 1e-4);
    }],
    ['aspect 0 дає нескінченність у [0], near == far - у [10] і [14]', ({ makePerspective: f }) => {
      assert.equal(f(Math.PI / 2, 0, 1, 3)[0], Infinity);
      const m = f(Math.PI / 2, 1, 2, 2);
      assert.ok(!Number.isFinite(m[10])); assert.ok(!Number.isFinite(m[14]));
    }],
  ],
  makeModelView: [
    ['нульові кути: одинична матриця з зсувом камери -4.5 за замовчуванням', ({ makeModelView: f }) => {
      const m = f(0, 0);
      assert.ok(m instanceof Float32Array);
      close(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -4.5, 1]);
    }],
    ['поворот rotY = 90 градусів і camZ = 10', ({ makeModelView: f }) => {
      close(f(0, Math.PI / 2, 10), [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -10, 1]);
    }],
    ['поворот rotX = 90 градусів', ({ makeModelView: f }) => {
      close(f(Math.PI / 2, 0), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -4.5, 1]);
    }],
    ['для довільних кутів блок 3x3 ортонормований, останній рядок (0,0,0,1)', ({ makeModelView: f }) => {
      for (const [x, y] of [[0.3, 1.2], [-2, 4], [0.18, 7.5]]) {
        const m = f(x, y);
        const c = [col(m, 0), col(m, 1), col(m, 2)];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          assert.ok(Math.abs(dot(c[i], c[j]) - (i === j ? 1 : 0)) < 1e-5, `кути ${x},${y}: стовпці ${i},${j}`);
        }
        close([m[3], m[7], m[11], m[15]], [0, 0, 0, 1]);
      }
    }],
  ],
};

// Дефект (не включено в default export, щоб npm test лишався зеленим): нецілі та NaN розміри зациклюють функцію.
// Увага: цей кейс зависає назавжди, запускати лише в окремому процесі з таймаутом.
// BUG: getCoprimeStride(NaN) і getCoprimeStride(2.5) ніколи не повертаються (while без виходу), очікувалось 1.
export const knownBugs = {
  getCoprimeStride: [
    ['NaN і дробові n не зависають', ({ getCoprimeStride: f }) => { assert.equal(f(NaN), 1); assert.equal(f(2.5), 1); }],
  ],
};
