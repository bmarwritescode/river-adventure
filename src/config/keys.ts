/** Key bindings (KeyboardEvent.code values). One place to rebind anything. */
export const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  walkHold: ['AltLeft', 'AltRight'],
  walkToggle: ['KeyC'],
  jump: ['Space'],
  sniff: ['KeyE'],
  sit: ['KeyX'],
  playBow: ['KeyB'],
  copyPosition: ['KeyP'],
  toggleGui: ['Backquote'],
  toggleTriggerZones: ['KeyT'],
  toggleTopDown: ['KeyM'],
} as const;

export type Action = keyof typeof KEYS;
