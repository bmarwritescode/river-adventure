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
  copyPosition: ['KeyP'],
  toggleGui: ['Backquote'],
  toggleTriggerZones: ['KeyT'],
} as const;

export type Action = keyof typeof KEYS;
