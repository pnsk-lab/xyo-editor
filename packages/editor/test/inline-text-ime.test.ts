import { describe, expect, it } from 'bun:test'
import { shouldDeferInlineTextKeyToIme } from '../src/features/costumes/inline-text-ime'

describe('inline-text IME guard', () => {
  it('defers to the IME on isComposing / composition window / keyCode 229', () => {
    expect(shouldDeferInlineTextKeyToIme({ isComposing: true }, false)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({ isComposing: false }, true)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({ keyCode: 229 }, false)).toBe(true)
    expect(shouldDeferInlineTextKeyToIme({ which: 229 }, false)).toBe(true)
  })

  it('keeps plain keys on the normal path (Escape commit, Enter newline)', () => {
    expect(shouldDeferInlineTextKeyToIme({ isComposing: false, keyCode: 27 }, false)).toBe(false)
    expect(shouldDeferInlineTextKeyToIme({}, false)).toBe(false)
  })
})
