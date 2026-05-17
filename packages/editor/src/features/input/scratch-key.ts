export function scratchKeyName(event: KeyboardEvent) {
  if (event.key === ' ') return 'space'
  if (event.key === 'ArrowUp') return 'up arrow'
  if (event.key === 'ArrowDown') return 'down arrow'
  if (event.key === 'ArrowLeft') return 'left arrow'
  if (event.key === 'ArrowRight') return 'right arrow'
  return event.key.length === 1 ? event.key.toLowerCase() : event.key
}
