import { Game } from './core/Game';

const container = document.getElementById('app');
if (!container) throw new Error('#app container missing');

const game = new Game(container);
game.start();
