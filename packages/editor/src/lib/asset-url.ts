/**
 * Resolve a `public/` path against the deployment base.
 *
 * The editor is served both from the site root and from a subpath (for example
 * GitHub Pages' `/xyo-editor/`), so absolute `/foo` URLs would break there.
 * `import.meta.env.BASE_URL` is injected by Vite and already ends in `/`.
 */
export function assetUrl(path: string): string {
  const base = typeof import.meta.env?.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
  return `${base}${path.replace(/^\/+/, '')}`
}
