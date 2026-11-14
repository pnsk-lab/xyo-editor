import { describe, expect, it } from 'bun:test'
import {
  PROJECT_VIEWPORT_IDENTITY_PREFIX,
  formatProjectViewportIdentity,
  initialProjectViewportGeneration,
  nextProjectViewportGeneration,
  resolveCostumeViewportIdentity,
} from '../src/features/costumes/project-viewport-identity'
import { buildCostumeViewportKey } from '../src/features/costumes/costume-viewport'

describe('project-viewport-identity helper', () => {
  it('starts at generation 0 with a non-empty scoped token', () => {
    expect(initialProjectViewportGeneration()).toBe(0)
    expect(formatProjectViewportIdentity(0)).toBe(`${PROJECT_VIEWPORT_IDENTITY_PREFIX}0`)
    expect(formatProjectViewportIdentity(0)).not.toBe('')
  })

  it('increases monotonically on every success bump', () => {
    let gen = initialProjectViewportGeneration()
    const seen = new Set([formatProjectViewportIdentity(gen)])
    for (let i = 0; i < 5; i += 1) {
      const next = nextProjectViewportGeneration(gen)
      expect(next).toBeGreaterThan(gen)
      expect(seen.has(formatProjectViewportIdentity(next))).toBe(false)
      seen.add(formatProjectViewportIdentity(next))
      gen = next
    }
  })

  it('fails closed instead of reusing a previous token', () => {
    expect(nextProjectViewportGeneration(Number.NaN)).toBe(1)
    expect(nextProjectViewportGeneration(-3)).toBe(1)
    expect(nextProjectViewportGeneration('2')).toBe(1)
    expect(formatProjectViewportIdentity(undefined)).toBe(`${PROJECT_VIEWPORT_IDENTITY_PREFIX}0`)
    expect(formatProjectViewportIdentity('')).toBe(`${PROJECT_VIEWPORT_IDENTITY_PREFIX}0`)
  })

  it('separates identical asset slots by project generation (fresh fit)', () => {
    const slot = 'sprite1:0'
    const asset = 'abc123.png'
    const before = buildCostumeViewportKey({ projectId: formatProjectViewportIdentity(0), slotKey: slot, assetKey: asset, mode: 'bitmap' })
    const after = buildCostumeViewportKey({ projectId: formatProjectViewportIdentity(1), slotKey: slot, assetKey: asset, mode: 'bitmap' })
    expect(after).not.toBe(before)
    // Same generation reproduces the key (rename/reorder-safe).
    expect(buildCostumeViewportKey({ projectId: formatProjectViewportIdentity(1), slotKey: slot, assetKey: asset, mode: 'bitmap' })).toBe(after)
  })

  it('keeps per-mode screens distinct for the same project + slot + asset', () => {
    const project = formatProjectViewportIdentity(3)
    const slot = 'sprite1:0'
    const asset = 'abc123.png'
    const bitmap = buildCostumeViewportKey({ projectId: project, slotKey: slot, assetKey: asset, mode: 'bitmap' })
    const vector = buildCostumeViewportKey({ projectId: project, slotKey: slot, assetKey: asset, mode: 'vector' })
    expect(bitmap).not.toBe(vector)
  })

  it('keeps costume identity stably empty so mode switches never fork the viewport key', () => {
    // Regression guard for the viewport-paper-reset mode transition
    // (vector 200% -> bitmap -> vector must restore 200%): `vm.updateCostume`
    // mints a new md5ext on every data write (save/flip/either conversion),
    // so threading md5ext through would abandon the settled vector key on
    // each conversion. Stable-empty keeps vector slot-scoped and lets bitmap
    // use its settled `bitmapFitState.assetKey` fallback; project separation
    // still comes from the project segment above.
    expect(resolveCostumeViewportIdentity({ md5ext: 'abc.png', assetId: 'deadbeef' })).toBe('')
    expect(resolveCostumeViewportIdentity({ assetId: 'deadbeef' })).toBe('')
    expect(resolveCostumeViewportIdentity({ md5ext: '', assetId: 'deadbeef' })).toBe('')
    expect(resolveCostumeViewportIdentity(undefined)).toBe('')
    expect(resolveCostumeViewportIdentity(null)).toBe('')
    expect(resolveCostumeViewportIdentity({})).toBe('')
    // Same asset input always yields the same string (stable across renders).
    const costume = { md5ext: 'same-bytes.png', assetId: 'same-id' }
    expect(resolveCostumeViewportIdentity(costume)).toBe(resolveCostumeViewportIdentity({ ...costume }))
    // Empty explicit identity agrees with the settled fallback shape: both
    // resolve to the slot asset segment, so the key never forks between
    // explicit and fallback.
    const slotAsset = 'abc123.png'
    const withFallback = buildCostumeViewportKey({ projectId: formatProjectViewportIdentity(0), slotKey: 's:0', assetKey: slotAsset, mode: 'bitmap' })
    const slotScoped = buildCostumeViewportKey({ projectId: formatProjectViewportIdentity(0), slotKey: 's:0', assetKey: resolveCostumeViewportIdentity({ md5ext: slotAsset }) || undefined, mode: 'bitmap' })
    // Bitmap without an explicit segment falls back to the slot segment only
    // when no settled owner exists; the point here is the explicit prop never
    // injects a per-edit md5 that would fork the key.
    expect(resolveCostumeViewportIdentity({ md5ext: slotAsset })).toBe('')
    expect(withFallback).toContain('asset=abc123.png')
    expect(slotScoped).toContain('asset=slot')
  })
})
