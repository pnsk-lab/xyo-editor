# Hikkaku Scratch Editor

Clean-room Scratch-compatible editor package for the implementation workspace.

The editor is built with Svelte, Vite, Tailwind CSS v4, Blockly, and the local
`@hikkaku/vm` package. It owns the browser UI: stage controls, sprite and
costume selectors, block workspace integration, paint editing, sound editing,
asset import, and VM event binding.

## Development

```sh
pnpm dev
pnpm check
pnpm build
```

The primary application shell lives in `src/App.svelte`.
