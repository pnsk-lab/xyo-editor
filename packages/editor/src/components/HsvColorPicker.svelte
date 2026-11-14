<!-- Shared HSV picker (Scratch Paint parity, implementation written independently).
  Three 0-100 sliders (hue ×3.6 = degrees, saturation, brightness) bound to one
  opaque hex string. Native range inputs keep keyboard arrows, touch drag, and
  screen-reader values for free; the gradient track behind each slider previews
  its own channel with the other two fixed. Continuous `step="any"` keeps
  derived positions exact (no step snapping) while arrows still step by 1.
  - Transparent / MIXED selections show the default position and never write
    until the user moves a slider; the first move emits a fresh hex and the
    parent live-applies only that color side to the vector selection at once
    (transparent becomes opaque, other dirty fill/stroke fields are untouched).
    The gesture coalesces to exactly one Undo entry when it closes.
  - Local hue/saturation/brightness state survives achromatic stops (dragging
    hue while gray keeps the hue instead of snapping to 0); external hex or
    `syncKey` changes resync from the hex.
  - History lives with the parent live gesture: `onHexInput` repaints
    immediately, `onHexCommit` closes the coalesced entry. -->
<script lang="ts">
  import { HSV_DEFAULT, displayHsvFor, hsv100ToHex, hsvReadout, hsvSliderBackground } from '../features/costumes/hsv-color'

  let {
    hex,
    idPrefix,
    onHexInput,
    onHexCommit,
    mixed = false,
    transparent = false,
    disabled = false,
    syncKey = '',
    hueLabel = 'Hue',
    saturationLabel = 'Saturation',
    brightnessLabel = 'Brightness',
  } = $props<{
    /** Opaque `#rrggbb` hex the sliders edit. */
    hex: string
    /** Prefix for `data-testid`s (`${idPrefix}-hue`, …). */
    idPrefix: string
    /** Live update: rewrite the hex (fires continuously while dragging). */
    onHexInput: (hex: string) => void
    /** Commit: mark the field dirty / apply (fires on release). */
    onHexCommit?: () => void
    /** Selection holds several colors: show the default position, don't write. */
    mixed?: boolean
    /** Transparent toggle on: show the default position, don't write. */
    transparent?: boolean
    disabled?: boolean
    /** External selection/eyedropper epoch: resyncs the sliders from `hex`. */
    syncKey?: string
    hueLabel?: string
    saturationLabel?: string
    brightnessLabel?: string
  }>()

  // Local slider state. Plain `let` snapshots compare against the live props
  // inside the `$effect` below (which also runs on mount, so the initial
  // position derives from the hex without snapshotting props into `$state`
  // initializers).
  let hue = $state(HSV_DEFAULT.h)
  let saturation = $state(HSV_DEFAULT.s)
  let brightness = $state(HSV_DEFAULT.v)
  let lastEmitted: string | undefined = undefined
  let lastSyncKey: string | undefined = undefined
  let lastMixed: boolean | undefined = undefined
  let lastTransparent: boolean | undefined = undefined

  function resync(nextHex: string, nextMixed: boolean, nextTransparent: boolean) {
    const display = displayHsvFor(nextMixed || nextTransparent ? null : nextHex, nextMixed)
    hue = display.h
    saturation = display.s
    brightness = display.v
    lastEmitted = nextHex
  }

  $effect(() => {
    // External changes only: own drags set `lastEmitted` first, so a hex that
    // still matches it is ours (this keeps the hue stable through achromatic
    // stops and freezes the sliders on MIXED, like the reference picker which
    // ignores selection-only updates). An eyedropper pick changes the hex
    // without touching `lastEmitted`, so it resyncs even under MIXED; a
    // transparent flip parks the sliders on the default without writing, and
    // untoggling re-derives them from the kept hex.
    void hex
    void syncKey
    void mixed
    void transparent
    if (mixed) {
      lastSyncKey = syncKey
      lastMixed = true
      lastTransparent = transparent
      if (hex !== lastEmitted) resync(hex, true, transparent)
      return
    }
    if (transparent) {
      if (!lastTransparent) resync(hex, false, true)
      else if (hex !== lastEmitted) lastEmitted = hex
      lastSyncKey = syncKey
      lastMixed = false
      lastTransparent = true
      return
    }
    if (hex !== lastEmitted || syncKey !== lastSyncKey || lastMixed || lastTransparent) {
      lastSyncKey = syncKey
      lastMixed = false
      lastTransparent = false
      resync(hex, false, false)
    }
  })

  function emit(nextHue: number, nextSaturation: number, nextBrightness: number) {
    hue = nextHue
    saturation = nextSaturation
    brightness = nextBrightness
    const out = hsv100ToHex({ h: nextHue, s: nextSaturation, v: nextBrightness })
    lastEmitted = out
    onHexInput(out)
  }
</script>

<div class="flex min-w-44 flex-col gap-1" data-testid={`${idPrefix}-hsv`}>
  <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">
    <span class="w-16 shrink-0">{hueLabel}</span>
    <input
      class="hsv-slider w-28"
      type="range"
      min="0"
      max="100"
      step="any"
      value={hue}
      aria-label={hueLabel}
      data-testid={`${idPrefix}-hue`}
      {disabled}
      style={`background-image:${hsvSliderBackground('hue', { h: hue, s: saturation, v: brightness })}`}
      oninput={(event) => emit(event.currentTarget.valueAsNumber, saturation, brightness)}
      onchange={() => onHexCommit?.()}
    />
    <span class="w-8 shrink-0 text-right tabular-nums" data-testid={`${idPrefix}-hue-value`}>{hsvReadout(hue)}</span>
  </label>
  <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">
    <span class="w-16 shrink-0">{saturationLabel}</span>
    <input
      class="hsv-slider w-28"
      type="range"
      min="0"
      max="100"
      step="any"
      value={saturation}
      aria-label={saturationLabel}
      data-testid={`${idPrefix}-saturation`}
      {disabled}
      style={`background-image:${hsvSliderBackground('saturation', { h: hue, s: saturation, v: brightness })}`}
      oninput={(event) => emit(hue, event.currentTarget.valueAsNumber, brightness)}
      onchange={() => onHexCommit?.()}
    />
    <span class="w-8 shrink-0 text-right tabular-nums" data-testid={`${idPrefix}-saturation-value`}>{hsvReadout(saturation)}</span>
  </label>
  <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">
    <span class="w-16 shrink-0">{brightnessLabel}</span>
    <input
      class="hsv-slider w-28"
      type="range"
      min="0"
      max="100"
      step="any"
      value={brightness}
      aria-label={brightnessLabel}
      data-testid={`${idPrefix}-brightness`}
      {disabled}
      style={`background-image:${hsvSliderBackground('brightness', { h: hue, s: saturation, v: brightness })}`}
      oninput={(event) => emit(hue, saturation, event.currentTarget.valueAsNumber)}
      onchange={() => onHexCommit?.()}
    />
    <span class="w-8 shrink-0 text-right tabular-nums" data-testid={`${idPrefix}-brightness-value`}>{hsvReadout(brightness)}</span>
  </label>
</div>

<style>
  input.hsv-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 12px;
    border-radius: 9999px;
    border: 1px solid #cbd5e1;
    outline-offset: 2px;
    touch-action: pan-y;
  }
  input.hsv-slider:focus-visible {
    outline: 2px solid #8d5de8;
  }
  input.hsv-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #ffffff;
    border: 2px solid #8d5de8;
    cursor: pointer;
  }
  input.hsv-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ffffff;
    border: 2px solid #8d5de8;
    cursor: pointer;
  }
  input.hsv-slider:disabled {
    opacity: 0.4;
  }
  input.hsv-slider:disabled::-webkit-slider-thumb {
    cursor: default;
  }
</style>
