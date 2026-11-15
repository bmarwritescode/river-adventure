import * as THREE from 'three';
import { DOG_PROFILES } from '../config/dogProfiles';
import { findPlace, PLACES, SPAWN_PLACE_ID, TEST_TRIGGER_ZONES, type Place } from '../config/places';
import { TUNING } from '../config/tuning';
import { FollowCamera } from '../camera/FollowCamera';
import { DogController, type DogIntent, type Pace } from '../dog/DogController';
import { DogVisual } from '../dog/DogVisual';
import { Input } from '../input/Input';
import { createInitialGameState, type GameState } from '../game/GameState';
import { CollisionWorld } from '../world/collision';
import { Environment } from '../world/environment';
import { MapWorld, type NearestStreet } from '../world/map/MapWorld';
import { TriggerSystem } from '../world/triggers';
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
  readonly map: MapWorld;
  readonly cam: FollowCamera;
  private dogVisual: DogVisual;
  private readonly env: Environment;
  private readonly input: Input;
  private readonly loop: GameLoop;
  private readonly overlay: Overlay;
  private readonly toasts = new Toasts();
  private readonly panel: TuningPanel;
  private zoneView: TriggerZoneView | null = null;
  private readonly loadingEl = document.createElement('div');

  private walkToggled = false;
  private frames = 0;
  private enterCount = 0;
  private exitCount = 0;
  private mapReady = false;
  /** Dog can't move until collision for the tiles around it exists. */
  private frozen = true;
  private readonly lastInside = { x: 0, z: 0 };
  private street: NearestStreet | null = null;
  private streetTimer = 0;
  private readonly intent: DogIntent = {
    moveX: 0, moveZ: 0, pace: 'trot', sniff: false, jump: false, sit: false, playBow: false,
  };

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.toasts.show('Graphics context lost — reload the page', 10);
    });

    this.input = new Input(canvas);
    this.env = new Environment(this.scene);
    this.map = new MapWorld(this.collision, this.renderer);
    this.scene.add(this.map.group);

    const profile = DOG_PROFILES[this.state.activeDogId];
    if (!profile) throw new Error(`Unknown dog profile: ${this.state.activeDogId}`);
    this.dog = new DogController(profile, this.collision);
    this.dogVisual = new DogVisual(this.dog);
    this.scene.add(this.dogVisual.root);
    this.cam = new FollowCamera(this.dog, this.collision, this.input, container.clientWidth / container.clientHeight);

    for (const z of TEST_TRIGGER_ZONES) this.triggers.add(z);
    this.triggers.on((e) => {
      if (e.type === 'enter') this.enterCount++;
      else this.exitCount++;
      this.toasts.show(`${e.type === 'enter' ? 'Entered' : 'Left'}: ${e.zone.label}`);
    });

    this.overlay = new Overlay(this.dog);
    this.panel = new TuningPanel(profile, {
      rebuildDogVisual: () => this.rebuildDogVisual(),
      cameraProjectionChanged: () => {
        this.cam.camera.fov = TUNING.camera.fov;
        this.cam.camera.updateProjectionMatrix();
      },
      triggerZonesToggled: () => {
        if (this.zoneView) this.zoneView.visible = TUNING.debug.showTriggerZones;
      },
      resetCamera: () => this.cam.resetToProfile(),
      shadowsChanged: () => this.env.applyShadowSettings(),
      teleport: (id) => this.teleportTo(id),
      toast: (m) => this.toasts.show(m),
    });

    this.addHud();
    window.addEventListener('resize', () => this.onResize());
    this.loop = new GameLoop({ step: (dt) => this.step(dt), render: (a, fdt) => this.render(a, fdt) });
    this.exposeDebugApi();
  }

  /** Load map data, place the dog, start the loop. */
  async start(): Promise<void> {
    const at = new URLSearchParams(location.search).get('at');
    const spawn = (at && findPlace(at)) || findPlace(SPAWN_PLACE_ID);
    if (!spawn) throw new Error(`Spawn place '${SPAWN_PLACE_ID}' not found in PLACES`);
    this.loop.start(); // render the sky + loading text while data loads
    await this.map.init();
    this.placeDog(spawn);
    // Trigger zone visuals drape on the terrain, so build them after it has loaded.
    this.zoneView = new TriggerZoneView(this.triggers);
    this.zoneView.visible = TUNING.debug.showTriggerZones;
    this.scene.add(this.zoneView.group);
    this.mapReady = true;
  }

  // --- Fixed-step simulation ---------------------------------------------
  private step(dt: number): void {
    if (!this.mapReady) return;
    const inp = this.input;
    const right = (inp.isDown('right') ? 1 : 0) - (inp.isDown('left') ? 1 : 0);
    const fwd = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
    const dir = this.cam.inputToWorld(right, fwd);
    const len = Math.hypot(dir.x, dir.z);
    const scale = this.frozen ? 0 : len > 1 ? 1 / len : 1;
    this.intent.moveX = dir.x * scale;
    this.intent.moveZ = dir.z * scale;
    let pace: Pace = 'trot';
    if (inp.isDown('run')) pace = 'run';
    else if (inp.isDown('walkHold') || this.walkToggled) pace = 'walk';
    this.intent.pace = pace;
    this.intent.sniff = inp.isDown('sniff');
    this.intent.jump = !this.frozen && inp.consumePressed('jump');
    this.intent.sit = !this.frozen && inp.consumePressed('sit');
    this.intent.playBow = !this.frozen && inp.consumePressed('playBow');

    this.dog.step(dt, this.intent);

    // Safety net: the boundary walls should make this impossible, but never let the dog escape.
    const p = this.dog.position;
    if (this.map.isInsideBoundary(p.x, p.z)) {
      this.lastInside.x = p.x;
      this.lastInside.z = p.z;
    } else {
      this.dog.teleport(this.lastInside.x, this.lastInside.z);
    }
    this.triggers.update(p.x, p.z);
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
      if (this.zoneView) this.zoneView.visible = TUNING.debug.showTriggerZones;
    }
    if (inp.consumePressed('toggleTopDown')) {
      this.cam.topDown = !this.cam.topDown;
      this.env.setFogEnabled(!this.cam.topDown);
      this.toasts.show(this.cam.topDown ? 'Top-down view (wheel to zoom, M to exit)' : 'Follow camera', 1.5);
    }

    const p = this.dog.position;
    if (this.mapReady) {
      this.map.update(p.x, p.z);
      if (this.frozen && this.map.isReadyAt(p.x, p.z)) {
        this.frozen = false;
        this.loadingEl.style.display = 'none';
      }
      this.streetTimer -= frameDt;
      if (this.streetTimer <= 0) {
        this.streetTimer = TUNING.map.streetLookupInterval;
        this.street = this.map.nearestStreet(p.x, p.z);
      }
    }

    this.dogVisual.update(alpha, frameDt);
    this.cam.update(alpha, frameDt);
    this.env.update(p.x, p.y, p.z);
    this.zoneView?.update();
    this.renderer.render(this.scene, this.cam.camera);

    const inside = this.triggers.insideIds;
    const st = this.mapReady ? this.map.stats : null;
    const info = this.renderer.info.render;
    this.overlay.update(
      frameDt,
      `street ${this.street ? `${this.street.name} (${this.street.distance.toFixed(0)} m)` : '-'}\n` +
      `zones  ${inside.length ? inside.join(', ') : '-'}\n` +
      `pace   ${this.intent.pace}${this.walkToggled ? ' (walk toggle)' : ''}\n` +
      `draws  ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k\n` +
      (st ? `tiles  ${st.loaded} loaded, ${st.inFlight + st.queued} pending (last build ${st.lastBuildMs.toFixed(0)} ms)` : 'tiles  loading…'),
    );
  }

  private placeDog(place: Place): void {
    this.dog.teleport(place.x, place.z, place.heading ?? this.dog.heading);
    this.lastInside.x = place.x;
    this.lastInside.z = place.z;
    this.cam.resetToProfile();
    this.frozen = true;
    this.loadingEl.style.display = '';
  }

  private teleportTo(id: string): void {
    const place = findPlace(id);
    if (!place || !this.mapReady) return;
    this.placeDog(place);
    this.toasts.show(`Teleported to ${place.label}`);
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

  private addHud(): void {
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent =
      'WASD/arrows move · Shift run · Alt hold / C toggle walk · Space jump · E sniff · X sit · B play bow · ' +
      'click = mouse look (Esc releases) / drag · wheel zoom · P copy pos · T zones · M top-down · ` tuning';
    document.body.appendChild(help);

    const attribution = document.createElement('a');
    attribution.className = 'attribution';
    attribution.href = 'https://www.openstreetmap.org/copyright';
    attribution.target = '_blank';
    attribution.rel = 'noopener';
    attribution.textContent = '© OpenStreetMap contributors';
    document.body.appendChild(attribution);

    this.loadingEl.className = 'loading';
    this.loadingEl.textContent = 'Loading map…';
    document.body.appendChild(this.loadingEl);
  }

  private onResize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.cam.setAspect(w / h);
  }

  private exposeDebugApi(): void {
    const game = this;
    window.__game = {
      get ready() { return game.mapReady && !game.frozen; },
      get frames() { return game.frames; },
      get fps() { return game.overlay.fps; },
      get dog() {
        const d = game.dog;
        return {
          position: { ...d.position },
          heading: d.heading,
          state: d.state,
          speed: d.groundSpeed,
          insideObstacle: game.collision.overlapsCircle(d.position.x, d.position.z, d.profile.collisionRadius),
          insideBoundary: game.map.isInsideBoundary(d.position.x, d.position.z),
          visual: game.dogVisual.kind,
          clips: game.dogVisual.clipNames,
        };
      },
      get triggers() {
        return { inside: game.triggers.insideIds, enterCount: game.enterCount, exitCount: game.exitCount };
      },
      get map() {
        const s = game.mapReady ? game.map.stats : { loaded: 0, inFlight: 0, queued: 0, triangles: 0 };
        return { loadedTiles: s.loaded, pendingTiles: s.inFlight + s.queued, errors: game.map.errors };
      },
      get street() { return game.street?.name ?? null; },
      get drawCalls() { return game.renderer.info.render.calls; },
      get triangles() { return game.renderer.info.render.triangles; },
      places: PLACES.map((p) => ({ id: p.id, label: p.label })),
    };
  }
}
