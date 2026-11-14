import { describe, expect, it } from 'bun:test'
import {
  buildVectorTextMarkup,
  clampVectorTextPoint,
  firstStrongTextDirection,
  isKnownVectorTextFontFamily,
  isVectorTextEmpty,
  normalizeDocumentDirection,
  readDocumentTextDirection,
  readVectorTextElementContent,
  resolveEffectiveVectorTextFontFamily,
  resolveEffectiveVectorTextFontSize,
  resolveTextBaseDirection,
  resolveVectorTextCommit,
  setVectorTextElementContent,
  splitVectorTextLines,
  vectorTextFontNeedsUpdate,
  vectorTextPaintChangedFields,
  VECTOR_TEXT_FONT_OPTIONS,
  type VectorTextPaintToolbarSnapshot,
} from '../src/features/costumes/vector-text'

const paint = { defs: '', fill: '#ff0000' }

function textElement(markup: string) {
  // Bun unit tests run without DOMParser, so parse just enough of our own
  // `<text>` output: attributes plus either plain text or `<tspan>` rows.
  const attrs = new Map<string, string>()
  const tagMatch = /<text([^>]*)>([\s\S]*)<\/text>/.exec(markup)
  for (const match of (tagMatch?.[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(match[1]!, match[2]!)
  const body = tagMatch?.[2] ?? ''
  const unescape = (value: string) =>
    value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  type FakeChild = { nodeType: number; tagName?: string; data?: string; textContent: string; parentNode?: unknown }
  const spans: FakeChild[] = [...body.matchAll(/<tspan[^>]*>([\s\S]*?)<\/tspan>/g)].map((match) => ({
    nodeType: 1,
    tagName: 'TSPAN',
    textContent: unescape(match[1] ?? ''),
  }))
  const children: Array<{ tag: string; textContent: string }> = spans.length > 0
    ? spans.map((span) => ({ tag: 'tspan', textContent: span.textContent }))
    : [{ tag: '#text', textContent: unescape(body) }]
  const fakeTextNode = (data: string): FakeChild => ({ nodeType: 3, data, textContent: data })
  // Child nodes mirror a real DOM: plain text for the single-line shape,
  // one row node per `<tspan>` for multiline output.
  const childNodes: FakeChild[] = spans.length > 0 ? [...spans] : [fakeTextNode(unescape(body))]
  let currentBody = unescape(body)
  const fake = {
    tagName: 'TEXT',
    ownerDocument: {
      createElementNS: (_ns: string, tag: string) => {
        const node = { tag, textContent: '', attrs: new Map<string, string>() }
        return {
          setAttribute: (name: string, value: string) => node.attrs.set(name, value),
          get textContent() {
            return node.textContent
          },
          set textContent(value: string) {
            node.textContent = value
          },
          __node: node,
        }
      },
    },
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => {
      attrs.delete(name)
    },
    get firstChild() {
      return children.length > 0 ? {} : null
    },
    removeChild: (_child: unknown) => {
      children.shift()
      spans.shift()
      childNodes.shift()
    },
    appendChild: (child: { __node: { textContent: string } }) => {
      children.push({ tag: 'tspan', textContent: child.__node.textContent })
      const span: FakeChild = {
        nodeType: 1,
        tagName: 'TSPAN',
        textContent: child.__node.textContent,
        parentNode: fake as unknown,
      }
      spans.push(span)
      childNodes.push(span)
    },
    get childNodes() {
      return childNodes as unknown as NodeListOf<ChildNode>
    },
    getElementsByTagName: (tag: string) => (tag === 'tspan' ? spans : []),
    get textContent() {
      // Real textContent concatenates all descendant text; the single-line
      // shape holds it in currentBody, multiline rows join without newlines.
      return spans.length > 0 ? spans.map((span) => span.textContent).join('') : currentBody
    },
    set textContent(value: string) {
      spans.length = 0
      children.length = 0
      childNodes.length = 0
      currentBody = value
      childNodes.push(fakeTextNode(value))
      children.push({ tag: '#text', textContent: value })
    },
  }
  for (const span of spans) span.parentNode = fake as unknown
  return fake as unknown as Element
}

/**
 * Build a `<text>` fake straight from child nodes (real-DOM shape) so tests
 * can express nesting and pretty-print whitespace that markup parsing alone
 * cannot. Tspan `textContent` must already include nested text, as in a real
 * DOM.
 */
function textElementFromChildren(
  kids: Array<
    | { kind: 'text'; data: string }
    | { kind: 'tspan'; text: string; nested?: string[] }
  >,
) {
  type FakeChild = { nodeType: number; tagName?: string; data?: string; textContent: string; parentNode?: unknown; childNodes?: FakeChild[] }
  const fake = {
    tagName: 'TEXT',
    getElementsByTagName: (tag: string) => (tag === 'tspan' ? allSpans : []),
  } as unknown as Element & { childNodes: FakeChild[] }
  const top: FakeChild[] = []
  const allSpans: FakeChild[] = []
  for (const kid of kids) {
    if (kid.kind === 'text') {
      top.push({ nodeType: 3, data: kid.data, textContent: kid.data })
      continue
    }
    const nested: FakeChild[] = []
    const row: FakeChild = { nodeType: 1, tagName: 'TSPAN', textContent: kid.text, parentNode: fake, childNodes: nested }
    top.push(row)
    // getElementsByTagName observes document order (row before its nested).
    allSpans.push(row)
    for (const text of kid.nested ?? []) {
      const inner: FakeChild = { nodeType: 1, tagName: 'TSPAN', textContent: text, parentNode: row, childNodes: [] }
      nested.push(inner)
      allSpans.push(inner)
    }
  }
  ;(fake as { childNodes: FakeChild[] }).childNodes = top
  return fake
}

describe('vector inline text helpers', () => {
  it('exposes a font shortlist', () => {
    expect(VECTOR_TEXT_FONT_OPTIONS.length).toBeGreaterThan(0)
    for (const option of VECTOR_TEXT_FONT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.value.length).toBeGreaterThan(0)
    }
  })

  it('treats whitespace-only drafts as empty', () => {
    expect(isVectorTextEmpty('')).toBe(true)
    expect(isVectorTextEmpty('   \n \n')).toBe(true)
    expect(isVectorTextEmpty('a')).toBe(false)
  })

  it('normalizes CRLF and caps lines', () => {
    expect(splitVectorTextLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
    expect(splitVectorTextLines(Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')).length).toBe(30)
  })

  it('builds single-line markup compatible with the legacy shape', () => {
    const markup = buildVectorTextMarkup({
      x: 10,
      y: 20,
      text: 'hi',
      paint,
      strokeColor: '#000',
      strokeWidth: 4,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial, sans-serif',
    })
    expect(markup).toContain('<text')
    expect(markup).toContain('>hi</text>')
    expect(markup).not.toContain('<tspan')
  })

  it('paints text with an independent stroke gradient without touching fill defs', () => {
    const fillWithDefs = {
      defs: '<defs><linearGradient id="fill-g1"><stop offset="0" stop-color="#00ff00" stop-opacity="1"/></linearGradient></defs>',
      fill: 'url(#fill-g1)',
    }
    const markup = buildVectorTextMarkup({
      x: 10,
      y: 20,
      text: 'hi',
      paint: fillWithDefs,
      strokeColor: '#000',
      strokePaint: {
        defs: '<defs><linearGradient id="stroke-g9"><stop offset="0" stop-color="#ff0000" stop-opacity="1"/></linearGradient></defs>',
        stroke: 'url(#stroke-g9)',
      },
      strokeWidth: 4,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial, sans-serif',
    })
    expect(markup).toContain(fillWithDefs.defs)
    expect(markup).toContain('id="stroke-g9"')
    expect(markup).toContain('fill="url(#fill-g1)"')
    expect(markup).toContain('stroke="url(#stroke-g9)"')
  })

  it('escapes markup-breaking characters', () => {
    const markup = buildVectorTextMarkup({
      x: 0,
      y: 0,
      text: '<b>&"q"</b>',
      paint,
      strokeColor: '#000',
      strokeWidth: 0,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial',
    })
    expect(markup).not.toContain('<b>')
    expect(markup).toContain('&lt;b&gt;')
  })

  it('emits tspans for multiline text and reads them back', () => {
    const markup = buildVectorTextMarkup({
      x: 5,
      y: 6,
      text: 'one\ntwo',
      paint,
      strokeColor: '#000',
      strokeWidth: 0,
      opacity: 100,
      fontSize: 20,
      fontFamily: 'Arial',
    })
    expect(markup).toContain('<tspan')
    const element = textElement(markup)
    expect(readVectorTextElementContent(element)).toBe('one\ntwo')
  })

  it('updates an existing element in place', () => {
    const element = textElement('<text x="1" y="2">old</text>')
    expect(setVectorTextElementContent(element, 'new\nline', { x: 3, y: 4 })).toBe(true)
    expect(readVectorTextElementContent(element)).toBe('new\nline')
    expect(element.getAttribute('x')).toBe('3')
  })

  it('keeps single-line text as-is (no tspan rows)', () => {
    const element = textElement('<text x="1" y="2">hello</text>')
    expect(readVectorTextElementContent(element)).toBe('hello')
  })

  it('merges nested tspans into their parent line instead of extra lines', () => {
    // Real-DOM shape: the first row styles "inner" via a nested tspan, so
    // its textContent already contains the nested text.
    const element = textElementFromChildren([
      { kind: 'tspan', text: 'outerinner!', nested: ['inner'] },
      { kind: 'tspan', text: 'second' },
    ])
    expect(readVectorTextElementContent(element)).toBe('outerinner!\nsecond')
  })

  it('ignores pretty-print whitespace between tspan rows', () => {
    const element = textElementFromChildren([
      { kind: 'text', data: '\n  ' },
      { kind: 'tspan', text: 'one' },
      { kind: 'text', data: '\n  ' },
      { kind: 'tspan', text: 'two' },
      { kind: 'text', data: '\n' },
    ])
    expect(readVectorTextElementContent(element)).toBe('one\ntwo')
  })

  it('returns undefined for non-text elements', () => {
    const rect = { tagName: 'RECT', textContent: 'x' } as unknown as Element
    expect(readVectorTextElementContent(rect)).toBe(undefined)
  })

  it('resolves commit kinds without touching history', () => {
    expect(resolveVectorTextCommit(undefined, '')).toBe('noop')
    expect(resolveVectorTextCommit(undefined, 'hi')).toBe('insert')
    expect(resolveVectorTextCommit('hi', 'hi')).toBe('noop')
    expect(resolveVectorTextCommit('hi', 'bye')).toBe('update')
    expect(resolveVectorTextCommit('hi', '   ')).toBe('delete')
  })

  it('clamps click points into the vector canvas', () => {
    expect(clampVectorTextPoint({ x: -5, y: 400 })).toEqual({ x: 0, y: 360 })
  })

  it('detects the first strong direction (dir=auto semantics)', () => {
    expect(firstStrongTextDirection('hello')).toBe('ltr')
    expect(firstStrongTextDirection('שלום')).toBe('rtl')
    expect(firstStrongTextDirection('مرحبا')).toBe('rtl')
    // Mixed: the first strong character decides, weak prefixes are skipped.
    expect(firstStrongTextDirection('hello שלום')).toBe('ltr')
    expect(firstStrongTextDirection('שלום hello')).toBe('rtl')
    expect(firstStrongTextDirection('12 שלום')).toBe('rtl')
    expect(firstStrongTextDirection('12 hello')).toBe('ltr')
    // CJK is class L: unchanged LTR behavior.
    expect(firstStrongTextDirection('日本語テスト')).toBe('ltr')
    expect(firstStrongTextDirection('にほんご')).toBe('ltr')
    // No strong characters (digits/punctuation/whitespace only).
    expect(firstStrongTextDirection('123?! ')).toBe(undefined)
    expect(firstStrongTextDirection('')).toBe(undefined)
  })

  it('resolves the block direction from content or the document', () => {
    expect(resolveTextBaseDirection('hello')).toBe('ltr')
    expect(resolveTextBaseDirection('日本語')).toBe('ltr')
    expect(resolveTextBaseDirection('123')).toBe('ltr')
    expect(resolveTextBaseDirection('שלום')).toBe('rtl')
    // RTL content wins even in an explicitly LTR document.
    expect(resolveTextBaseDirection('שלום', 'ltr')).toBe('rtl')
    // An explicitly RTL document pins every block right (reference locale
    // justification parity), including LTR and neutral text.
    expect(resolveTextBaseDirection('hello', 'rtl')).toBe('rtl')
    expect(resolveTextBaseDirection('123', 'rtl')).toBe('rtl')
    expect(resolveTextBaseDirection('', 'rtl')).toBe('rtl')
    expect(resolveTextBaseDirection('', 'ltr')).toBe('ltr')
    expect(normalizeDocumentDirection('RTL')).toBe('rtl')
    expect(normalizeDocumentDirection('ltr')).toBe('ltr')
    expect(normalizeDocumentDirection('')).toBe(undefined)
    expect(normalizeDocumentDirection(null)).toBe(undefined)
    // No DOM in bun: falls back to content only, never throws.
    expect(readDocumentTextDirection()).toBe(undefined)
  })

  it('keeps LTR markup byte-identical to the historical shape', () => {
    const markup = buildVectorTextMarkup({
      x: 10,
      y: 20,
      text: 'hi',
      paint,
      strokeColor: '#000',
      strokeWidth: 4,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial, sans-serif',
    })
    expect(markup).toContain('text-anchor="middle"')
    expect(markup).not.toContain('direction=')
  })

  it('anchors RTL blocks at the right edge with the same x', () => {
    const markup = buildVectorTextMarkup({
      x: 10,
      y: 20,
      text: 'שלום',
      paint,
      strokeColor: '#000',
      strokeWidth: 4,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial, sans-serif',
    })
    expect(markup).toContain('x="10"')
    expect(markup).toContain('text-anchor="start"')
    expect(markup).toContain('direction="rtl"')
    expect(markup).toContain('>שלום</text>')
    const element = textElement(markup)
    // Content round-trips regardless of direction attributes.
    expect(readVectorTextElementContent(element)).toBe('שלום')
  })

  it('anchors RTL multiline rows on the same right edge', () => {
    const markup = buildVectorTextMarkup({
      x: 5,
      y: 6,
      text: 'שלום\nעולם',
      paint,
      strokeColor: '#000',
      strokeWidth: 0,
      opacity: 100,
      fontSize: 20,
      fontFamily: 'Arial',
    })
    expect(markup).toContain('text-anchor="start"')
    expect(markup).toContain('direction="rtl"')
    const element = textElement(markup)
    expect(readVectorTextElementContent(element)).toBe('שלום\nעולם')
  })

  it('honors an explicit direction over content sniffing', () => {
    const forced = buildVectorTextMarkup({
      x: 1,
      y: 2,
      text: 'hi',
      paint,
      strokeColor: '#000',
      strokeWidth: 0,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial',
      direction: 'rtl',
    })
    expect(forced).toContain('direction="rtl"')
    const pinned = buildVectorTextMarkup({
      x: 1,
      y: 2,
      text: 'שלום',
      paint,
      strokeColor: '#000',
      strokeWidth: 0,
      opacity: 100,
      fontSize: 24,
      fontFamily: 'Arial',
      direction: 'ltr',
    })
    expect(pinned).toContain('text-anchor="middle"')
    expect(pinned).not.toContain('direction=')
  })

  it('updates direction markers when re-editing text', () => {
    const element = textElement('<text x="1" y="2">hello</text>')
    expect(setVectorTextElementContent(element, 'שלום')).toBe(true)
    expect(element.getAttribute('text-anchor')).toBe('start')
    expect(element.getAttribute('direction')).toBe('rtl')
    expect(readVectorTextElementContent(element)).toBe('שלום')
    // Switching back to LTR restores the centered anchor and drops the marker.
    expect(setVectorTextElementContent(element, 'hello again')).toBe(true)
    expect(element.getAttribute('text-anchor')).toBe('middle')
    expect(element.getAttribute('direction')).toBeNull()
    expect(readVectorTextElementContent(element)).toBe('hello again')
  })

  it('leaves foreign LTR anchors alone and keeps transform on RTL edits', () => {
    const foreign = textElement('<text x="1" y="2">legacy</text>')
    ;(foreign as unknown as { setAttribute: (name: string, value: string) => void }).setAttribute('text-anchor', 'start')
    expect(setVectorTextElementContent(foreign, 'still ltr')).toBe(true)
    expect(foreign.getAttribute('text-anchor')).toBe('start')
    expect(foreign.getAttribute('direction')).toBeNull()

    const rotated = textElement('<text x="10" y="20" font-size="24" transform="rotate(15 10 20)">hi</text>')
    expect(setVectorTextElementContent(rotated, 'שלום עולם', { fontSize: 32 })).toBe(true)
    expect(rotated.getAttribute('transform')).toBe('rotate(15 10 20)')
    expect(rotated.getAttribute('text-anchor')).toBe('start')
    expect(rotated.getAttribute('font-size')).toBe('32')
    expect(readVectorTextElementContent(rotated)).toBe('שלום עולם')
  })

  it('resolves the effective font through inheritance and inline style', () => {
    const fontNode = (attrs: Record<string, string>, parent?: unknown) =>
      ({
        tagName: 'TEXT',
        getAttribute: (name: string) => attrs[name] ?? null,
        parentElement: (parent ?? null) as unknown,
        parentNode: (parent ?? null) as unknown,
      }) as unknown as Element
    // Own attribute wins over the ancestor.
    const own = fontNode({ 'font-family': 'Georgia, serif', 'font-size': '32' }, fontNode({ 'font-family': 'Ancestor, sans-serif', 'font-size': '48' }))
    expect(resolveEffectiveVectorTextFontFamily(own)).toBe('Georgia, serif')
    expect(resolveEffectiveVectorTextFontSize(own)).toBe(32)
    // Ancestor inheritance (external SVG `<g font-family>`).
    const inherited = fontNode({}, fontNode({ 'font-family': 'NonexistentFontXYZ, sans-serif', 'font-size': '20px' }))
    expect(resolveEffectiveVectorTextFontFamily(inherited)).toBe('NonexistentFontXYZ, sans-serif')
    expect(resolveEffectiveVectorTextFontSize(inherited)).toBe(20)
    // Inline style beats the presentation attribute on the same node.
    const styled = fontNode({ 'font-family': 'Attr, serif', 'font-size': '12', style: 'font-family: Styled, sans-serif; font-size: 40px' })
    expect(resolveEffectiveVectorTextFontFamily(styled)).toBe('Styled, sans-serif')
    expect(resolveEffectiveVectorTextFontSize(styled)).toBe(40)
    // `inherit` continues the walk; relative sizes fail closed to the ancestor.
    const inherit = fontNode({ 'font-family': 'inherit', style: 'font-size: 150%' }, fontNode({ 'font-family': 'Walked, serif', 'font-size': '22' }))
    expect(resolveEffectiveVectorTextFontFamily(inherit)).toBe('Walked, serif')
    expect(resolveEffectiveVectorTextFontSize(inherit)).toBe(22)
    // Nothing defined: default family, undefined size.
    const bare = fontNode({})
    expect(resolveEffectiveVectorTextFontFamily(bare)).toBe('Sans Serif')
    expect(resolveEffectiveVectorTextFontSize(bare)).toBe(undefined)
    expect(isKnownVectorTextFontFamily('Arial, sans-serif')).toBe(true)
    expect(isKnownVectorTextFontFamily('Sans Serif')).toBe(true)
    expect(isKnownVectorTextFontFamily('NonexistentFontXYZ, sans-serif')).toBe(false)
  })

  it('keeps font attributes untouched when only characters change', () => {
    // External artwork with ancestor inheritance and no own font attributes:
    // a characters-only edit must not flatten the stack to Arial/24.
    const element = textElement('<text x="1" y="2">old</text>')
    expect(setVectorTextElementContent(element, 'new text')).toBe(true)
    expect(element.getAttribute('font-family')).toBeNull()
    expect(element.getAttribute('font-size')).toBeNull()
    expect(readVectorTextElementContent(element)).toBe('new text')
    // Same-value intent is a no-op write: an explicit Sans Serif/40 over an
    // element that already renders Sans Serif/40 via inheritance adds no attribute.
    const inheritedArial = textElement('<text x="1" y="2">old</text>')
    expect(setVectorTextElementContent(inheritedArial, 'new', { fontSize: 40, fontFamily: 'Sans Serif' })).toBe(true)
    expect(vectorTextFontNeedsUpdate(inheritedArial, { fontSize: 40, fontFamily: 'Sans Serif' }).size).toBe(false)
    expect(vectorTextFontNeedsUpdate(inheritedArial, { fontSize: 40, fontFamily: 'Sans Serif' }).family).toBe(false)
    // A real change is detected and written.
    const sized = textElement('<text x="1" y="2" font-size="32">old</text>')
    expect(vectorTextFontNeedsUpdate(sized, { fontSize: 24 }).size).toBe(true)
    expect(vectorTextFontNeedsUpdate(sized, { fontFamily: 'Georgia, serif' }).family).toBe(true)
    expect(setVectorTextElementContent(sized, 'new', { fontSize: 24, fontFamily: 'Georgia, serif' })).toBe(true)
    expect(sized.getAttribute('font-size')).toBe('24')
    expect(sized.getAttribute('font-family')).toBe('Georgia, serif')
  })

  it('keeps per-row tspan presentation attributes across a re-edit', () => {
    const spanAttributes = [
      new Map([['fill', '#ff0000'], ['font-weight', '900']]),
      new Map([['fill', '#00ff00']]),
    ]
    const children = spanAttributes.map((entries) => ({
      tagName: 'TSPAN',
      getAttribute: (name: string) => entries.get(name) ?? null,
      getAttributeNames: () => [...entries.keys()],
    }))
    const created: Array<{ attrs: Map<string, string>; text: string }> = []
    const element = {
      tagName: 'TEXT',
      ownerDocument: {
        createElementNS: () => {
          const attrs = new Map<string, string>()
          const record = { attrs, text: '' }
          created.push(record)
          return {
            setAttribute: (name: string, value: string) => attrs.set(name, value),
            get textContent() {
              return record.text
            },
            set textContent(value: string) {
              record.text = value
            },
          }
        },
      },
      getAttribute: (name: string) => (name === 'x' ? '10' : null),
      setAttribute: () => {},
      removeAttribute: () => {},
      get firstChild() {
        return null
      },
      removeChild: () => {},
      appendChild: () => {},
      children,
      getElementsByTagName: () => [],
    } as unknown as Element
    expect(setVectorTextElementContent(element, 'one\ntwo', {})).toBe(true)
    expect(created.length).toBe(2)
    expect(created[0]!.attrs.get('fill')).toBe('#ff0000')
    expect(created[0]!.attrs.get('font-weight')).toBe('900')
    expect(created[1]!.attrs.get('fill')).toBe('#00ff00')
    expect(created[0]!.attrs.get('x')).toBe('10')
  })

  it('commits font-only edits as updates and same-value intent as no-ops', () => {
    expect(resolveVectorTextCommit('same', 'same')).toBe('noop')
    expect(resolveVectorTextCommit('same', 'same', false)).toBe('noop')
    expect(resolveVectorTextCommit('same', 'same', true)).toBe('update')
    expect(resolveVectorTextCommit(undefined, '', true)).toBe('noop')
    expect(resolveVectorTextCommit('hi', 'bye', false)).toBe('update')
  })

  it('commits paint-only edits as updates and same-value paint as no-ops', () => {
    expect(resolveVectorTextCommit('same', 'same', false, false)).toBe('noop')
    expect(resolveVectorTextCommit('same', 'same', false, true)).toBe('update')
    expect(resolveVectorTextCommit('same', 'same', true, false)).toBe('update')
    expect(resolveVectorTextCommit(undefined, '', false, true)).toBe('noop')
    expect(resolveVectorTextCommit('hi', 'bye', false, false)).toBe('update')
  })

  it('detects explicit toolbar paint changes during a text session', () => {
    const baseline: VectorTextPaintToolbarSnapshot = {
      fillTransparent: false,
      fillHex: '#ffab19',
      secondaryTransparent: false,
      secondaryHex: '#ffffff',
      paintGradient: 'solid',
      strokeTransparent: false,
      strokeHex: '#0f172a',
      secondaryStrokeTransparent: false,
      secondaryHex: '#ffffff',
      strokeGradient: 'solid',
      strokeWidth: 4,
      vectorOpacity: 100,
    }
    // Untouched toolbar: no explicit fields.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline })).toEqual([])
    // Hex case is normalized: same color different case is not a change.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, fillHex: '#FFAB19' })).toEqual([])
    // Primary fill change counts.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, fillHex: '#ff0000' })).toEqual(['fill'])
    // Transparent toggle counts even when the hex is kept for restore.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, fillTransparent: true })).toEqual(['fill'])
    // Unused secondary while solid stays a no-op (never flattens paint).
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, secondaryHex: '#ff0000' })).toEqual([])
    // Gradient kind change counts; secondary counts only when needed.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, paintGradient: 'horizontal' })).toEqual(['fillGradient'])
    expect(vectorTextPaintChangedFields(baseline, {
      ...baseline,
      paintGradient: 'horizontal',
      secondaryHex: '#ff0000',
    })).toEqual(['fillSecondary', 'fillGradient'])
    // Stroke + width + opacity.
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, strokeHex: '#ff0000' })).toEqual(['stroke'])
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, strokeWidth: 8 })).toEqual(['strokeWidth'])
    expect(vectorTextPaintChangedFields(baseline, { ...baseline, vectorOpacity: 55 })).toEqual(['opacity'])
  })
})
