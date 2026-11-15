import * as THREE from 'three';
import { DOG_PROFILES } from '../config/dogProfiles';
import { TUNING } from '../config/tuning';
import { FollowCamera } from '../camera/FollowCamera';
import { DogController, type DogIntent, type Pace } from '../dog/DogController';
import { DogVisual } from '../dog/DogVisual';
import { Input } from '../input/Input';
import { createInitialGameState, type GameState } from '../game/GameState';
import { CollisionWorld } from '../world/collision';
import { TriggerSystem } from '../world/triggers';
import { buildTestLevel, TEST_SPAWN, TEST_TRIGGER_ZONES, type TestLevel } from '../world/testLevel';
import { Overlay } from '../debug/Overlay';
import { Toasts } from '../debug/Toasts';
import { TuningPanel } from '../debug/TuningPanel';
import { TriggerZoneView } from '../debug/TriggerZoneView';
import { GameLoop } from './loop';

/** Top-level wiring: owns the renderer, world, dog, camera, and debug tools. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly collision = new CollisionWorld();
  readonly triggers = new TriggerSystem();
  readonly state: GameState = createInitialGameState();
  readonly dog: DogController;
  private dogVisual: DogVisual;
  readonly cam: FollowCamera;
  private readonly input: Input;
  private readonly level: TestLevel;
  private readonly loop: GameLoop;
  private readonly overlay: Overlay;
  private readonly toasts = new Toasts();
  private readonly panel: TuningPanel;
  private readonly zoneView: TriggerZoneView;

  private walkToggled = false;
  private frames = 0;
  private enterCount = 0;
  private exitCount = 0;
  private readonly intent: DogIntent = { moveX: 0, moveZ: 0, pace: 'trot', sniff: false, jump: false };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.toasts.show('Graphics context lost — reload the page', 10);
    });

    this.input = new Input(canvas);
    this.level = buildTestLevel(this.scene, this.renderer, this.collision);

    const profile = DOG_PROFILES[this.state.activeDogId];
    if (!profile) throw new Error(`Unknown dog profile: ${this.state.activeDogId}`);
    this.dog = new DogController(profile, this.collision);
    this.dog.teleport(TEST_SPAWN.x, TEST_SPAWN.z, TEST_SPAWN.heading);
    this.dogVisual = new DogVisual(this.dog);
    this.scene.add(this.dogVisual.root);

    this.cam = new FollowCamera(this.dog, this.collision, this.input, container.clientWidth / container.clientHeight);

    for (const z of TEST_TRIGGER_ZONES) this.triggers.add(z);
    this.triggers.on((e) => {
      if (e.type === 'enter') this.enterCount++;
      else this.exitCount++;
      this.toasts.show(`${e.type === 'enter' ? 'Entered' : 'Left'}: ${e.zone.label}`);
    });
    this.zoneView = new TriggerZoneView(this.triggers);
    this.zoneView.visible = TUNING.debug.showTriggerZones;
    this.scene.add(this.zoneView.group);

    this.overlay = new Overlay(this.dog);
    this.panel = new TuningPanel(profile, {
      rebuildDogVisual: () => this.rebuildDogVisual(),
      cameraProjectionChanged: () => {
        this.cam.camera.fov = TUNING.camera.fov;
        this.cam.camera.updateProjectionMatrix();
      },
      triggerZonesToggled: () => (this.zoneView.visible = TUNING.debug.showTriggerZones),
      resetCamera: () => this.cam.resetToProfile(),
      toast: (m) => this.toasts.show(m),
    });

    const help = document.createElement('div');
    help.className = 'help';
    help.textContent =
      'WASD/arrows move · Shift run · Alt hold / C toggle walk · Space jump · E sniff · ' +
      'click = mouse look (Esc releases) / drag · wheel zoom · P copy pos · T zones · ` tuning';
    document.body.appendChild(help);

    window.addEventListener('resize', () => this.onResize(container));
    this.loop = new GameLoop({ step: (dt) => this.step(dt), render: (a, fdt) => this.render(a, fdt) });
    this.exposeDebugApi();
  }

  start(): void {
    this.loop.start();
  }

  // --- Fixed-step simulation ---------------------------------------------
  private step(dt: number): void {
    const inp = this.input;
    const right = (inp.isDown('right') ? 1 : 0) - (inp.isDown('left') ? 1 : 0);
    const fwd = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
    const dir = this.cam.inputToWorld(right, fwd);
    const len = Math.hypot(dir.x, dir.z);
    this.intent.moveX = len > 1 ? dir.x / len : dir.x;
    this.intent.moveZ = len > 1 ? dir.z / len : dir.z;
    let pace: Pace = 'trot';
    if (inp.isDown('run')) pace = 'run';
    else if (inp.isDown('walkHold') || this.walkToggled) pace = 'walk';
    this.intent.pace = pace;
    this.intent.sniff = inp.isDown('sniff');
    this.intent.jump = inp.consumePressed('jump');

    this.dog.step(dt, this.intent);
    this.triggers.update(this.dog.position.x, this.dog.position.z);
  }

  // --- Per-frame rendering + non-sim input ---------------------------------
  private render(alpha: number, frameDt: number): void {
    this.frames++;
    const inp = this.input;
    if (inp.consumePressed('walkToggle')) {
      this.walkToggled = !this.walkToggled;
      this.toasts.show(this.walkToggled ? 'Walk mode ON' : 'Walk mode OFF', 1.2);
    }
    if (inp.consumePressed('copyPosition')) this.copyPosition();
    if (inp.consumePressed('toggleGui')) this.panel.toggle();
    if (inp.consumePressed('toggleTriggerZones')) {
      TUNING.debug.showTriggerZones = !TUNING.debug.showTriggerZones;
      this.zoneView.visible = TUNING.debug.showTriggerZones;
    }

    this.dogVisual.update(alpha, frameDt);
    this.cam.update(alpha, frameDt);
    this.level.followShadow(this.dog.position.x, this.dog.position.z);
    this.zoneView.update();
    this.renderer.render(this.scene, this.cam.camera);

    const inside = this.triggers.insideIds;
    this.overlay.update(
      frameDt,
      `zones  ${inside.length ? inside.join(', ') : '-'}\n` +
      `pace   ${this.intent.pace}${this.walkToggled ? ' (walk toggle)' : ''}\n` +
      `draws  ${this.renderer.info.render.calls}`,
    );
  }

  private copyPosition(): void {
    const p = this.dog.position;
    const snippet = `{ x: ${p.x.toFixed(1)}, z: ${p.z.toFixed(1)} }`;
    console.info('[position]', snippet);
    const ok = (): void => this.toasts.show(`Copied ${snippet}`);
    const fail = (): void => this.toasts.show(`${snippet}  (clipboard blocked — also in console)`, 4);
    try {
      const pending = navigator.clipboard?.writeText(snippet);
      if (pending) pending.then(ok, fail);
      else fail();
    } catch {
      fail();
    }
  }

  private rebuildDogVisual(): void {
    this.dogVisual.dispose();
    this.dogVisual = new DogVisual(this.dog);
    this.scene.add(this.dogVisual.root);
  }

  private onResize(container: HTMLElement): void {
    const w = container.clientWidth, h = container.clientHeight;
    this.renderer.setSize(w, h);
    this.cam.setAspect(w / h);
  }

  private exposeDebugApi(): void {
    const game = this;
    window.__game = {
      ready: true,
      get frames() { return game.frames; },
      get fps() { return game.overlay.fps; },
      get dog() {
        const d = game.dog;
        return {
          position: { ...d.position },
          heading: d.heading,
          state: d.state,
          speed: d.groundSpeed,
        };
      },
      get triggers() {
        return { inside: game.triggers.insideIds, enterCount: game.enterCount, exitCount: game.exitCount };
      },
      get drawCalls() { return game.renderer.info.render.calls; },
    };
  }
}
