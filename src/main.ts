import { Game } from './core/Game';

const container = document.getElementById('app');
if (!container) throw new Error('#app container missing');

const game = new Game(container);
game.start().catch((err: unknown) => {
  console.error('Failed to start game:', err);
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent = `Failed to load the map: ${String(err)}`;
  document.body.appendChild(el);
});
