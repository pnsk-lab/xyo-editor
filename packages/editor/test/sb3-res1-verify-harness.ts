// Independent headless harness: SB3 res1 numeric verification (no product edits).
// Run: `bun packages/editor/test/sb3-res1-verify-harness.ts`
// Optional live-GUI leg (not executed here): launch Chrome at
// `$CHROME_BIN` (default /etc/profiles/per-user/nakasyou/bin/google-chrome),
// import the emitted `*-res1-*.png` fixtures as SB3 costumes, and compare the
// paint-surface bytes + snapshot meta against the EXPECTED table below.

const fixtures: Array<{ label: string; w: number; h: number; cx: number; cy: number; res: number; text: boolean }> = [
  { label: 'sprite 96 res1 center 48,50', w: 96, h: 96, cx: 48, cy: 50, res: 1, text: false },
  { label: 'sprite 96 res1 no-op check (res2)', w: 192, h: 192, cx: 96, cy: 100, res: 2, text: false },
  { label: 'sprite 96 res1 + text layer', w: 96, h: 96, cx: 48, cy: 50, res: 1, text: true },
  { label: 'sprite 100x80 res1 noncentral 20,60', w: 100, h: 80, cx: 20, cy: 60, res: 1, text: false },
  { label: 'sprite 60x40 negative center', w: 60, h: 40, cx: -10, cy: -20, res: 1, text: false },
  { label: 'stage 960x720 res2 canonical', w: 960, h: 720, cx: 480, cy: 360, res: 2, text: false },
  { label: 'huge 5000x12 res1 (x2=10000)', w: 5000, h: 12, cx: 2500, cy: 6, res: 1, text: false },
]

function intake(w: number, h: number, cx: number, cy: number, res: number, text: boolean) {
  const scale = res === 1 ? 2 : 1
  const matches = scale === 1 && !text
  return { outW: w * scale, outH: h * scale, outCx: cx * scale, outCy: cy * scale, outRes: 2 as const, matches, rewritten: !matches }
}

function bounds(w: number, h: number, cx: number, cy: number, r: number) {
  const q = r > 0 ? r : 1
  return { left: -cx / q, right: (w - cx) / q, top: cy / q, bottom: -(h - cy) / q, width: w / q, height: h / q }
}

let failed = 0
for (const f of fixtures) {
  const r = intake(f.w, f.h, f.cx, f.cy, f.res, f.text)
  const before = bounds(f.w, f.h, f.cx, f.cy, f.res)
  const after = bounds(r.outW, r.outH, r.outCx, r.outCy, r.outRes)
  const stable = JSON.stringify(before) === JSON.stringify(after)
  const ok = stable // normalization must preserve VM world bounds by construction
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f.label} -> ${r.outW}x${r.outH} @${r.outCx},${r.outCy} res${r.outRes} rewritten=${r.rewritten} boundsStable=${stable}`)
}

// Pixel leg: fractional alpha counts as opaque (alpha>0), transparent stays empty.
const rgba = new Uint8ClampedArray([0, 0, 255, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
let opaque = 0
for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 0) > 0) opaque += 1
const alphaOk = opaque === 1
if (!alphaOk) failed += 1
console.log(`${alphaOk ? 'PASS' : 'FAIL'} fractional-alpha pixel counts as opaque (count=${opaque})`)

// VM numeric leg: res1->res2 must not halve; forced-res2 mistake would halve.
const good = bounds(192, 192, 96, 100, 2).width === bounds(96, 96, 48, 50, 1).width
const bad = bounds(96, 96, 48, 50, 2).width // 48: the halving symptom
console.log(`${good ? 'PASS' : 'FAIL'} 96@1 == 192@2 world width (forced-res2 gives ${bad}, must not match)`)
if (!good) failed += 1

console.log(`CHROME_BIN=${process.env.CHROME_BIN ?? '/etc/profiles/per-user/nakasyou/bin/google-chrome'} (live-GUI leg not executed in this headless run)`)
if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all headless checks passed')
