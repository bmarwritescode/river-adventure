import GUI from 'lil-gui';
import type { DogProfile } from '../config/dogProfiles';
import { PLACES } from '../config/places';
import { TUNING } from '../config/tuning';

export interface TuningPanelHooks {
  /** Rebuild meshes after dimension/color changes. */
  rebuildDogVisual(): void;
  /** Camera projection settings changed. */
  cameraProjectionChanged(): void;
  /** Called when the trigger-zone debug view checkbox flips. */
  triggerZonesToggled(): void;
  /** Reset camera framing to the profile's defaults. */
  resetCamera(): void;
  /** Shadow range / resolution changed. */
  shadowsChanged(): void;
  /** Jump the dog to a named place (id from config/places.ts). */
  teleport(placeId: string): void;
  toast(msg: string): void;
}

/**
 * lil-gui panel over TUNING and the active DogProfile. Values are read live by
 * the game, so most controls need no onChange. Toggle with backtick.
 * "Copy values" puts the current numbers on the clipboard to paste back into config.
 */
export class TuningPanel {
  private readonly gui = new GUI({ title: 'Tuning  (` to hide)', width: 320 });
  private shown = false;

  constructor(profile: DogProfile, hooks: TuningPanelHooks) {
    const gui = this.gui;
    gui.hide();

    // Teleport: pick a named spot (config/places.ts) to jump there instantly.
    const tp = { place: '' };
    const options: Record<string, string> = { '— teleport to… —': '' };
    for (const p of PLACES) options[p.label] = p.id;
    const tpCtl = gui.add(tp, 'place', options).name('Teleport').onChange((id: string) => {
      if (id) hooks.teleport(id);
      tp.place = '';
      tpCtl.updateDisplay();
    });
    tpCtl.domElement.querySelector('select')?.setAttribute('data-testid', 'teleport');

    const dog = gui.addFolder(`Dog: ${profile.displayName}`);
    const sp = dog.addFolder('Speeds (m/s)');
    sp.add(profile.speeds, 'walk', 0.2, 4, 0.05);
    sp.add(profile.speeds, 'trot', 0.5, 8, 0.05);
    sp.add(profile.speeds, 'run', 1, 16, 0.1);
    sp.add(profile.speeds, 'sniff', 0, 2, 0.05);
    const mv = dog.addFolder('Movement');
    mv.add(profile.movement, 'acceleration', 0.5, 40, 0.1).name('accel (m/s²)');
    mv.add(profile.movement, 'deceleration', 0.5, 40, 0.1).name('decel (m/s²)');
    mv.add(profile.movement, 'brakeDeceleration', 0.5, 60, 0.1).name('brake (m/s²)');
    mv.add(profile.movement, 'turnRateSlow', 0.5, 20, 0.1).name('turn slow (rad/s)');
    mv.add(profile.movement, 'turnRateFast', 0.2, 20, 0.1).name('turn fast (rad/s)');
    mv.add(profile.movement, 'airControl', 0, 1, 0.01);
    const jp = dog.addFolder('Jump');
    jp.add(profile.jump, 'height', 0.05, 2, 0.01).name('height (m)');
    jp.add(profile.jump, 'cooldown', 0, 1, 0.01).name('cooldown (s)');
    dog.add(profile, 'collisionRadius', 0.05, 1, 0.01).name('collision radius');
    const cam = dog.addFolder('Camera framing');
    cam.add(profile.camera, 'lookHeight', 0, 3, 0.01);
    cam.add(profile.camera, 'distance', 0.5, 15, 0.05).name('default distance').onFinishChange(hooks.resetCamera);
    cam.add(profile.camera, 'minDistance', 0.3, 5, 0.05);
    cam.add(profile.camera, 'maxDistance', 2, 30, 0.1);
    cam.add(profile.camera, 'pitch', -0.15, 1.2, 0.01).name('default pitch (rad)').onFinishChange(hooks.resetCamera);
    cam.add(profile.camera, 'sniffLookHeight', 0, 2, 0.01);
    cam.add(profile.camera, 'sniffDistance', 0.3, 6, 0.05);
    const dims = dog.addFolder('Dimensions (m) — rebuilds box').close();
    for (const k of ['shoulderHeight', 'length', 'headTopHeight', 'chestWidth'] as const) {
      dims.add(profile.dimensions, k, 0.05, 2, 0.01).onFinishChange(hooks.rebuildDogVisual);
    }

    const c = gui.addFolder('Camera (global)').close();
    c.add(TUNING.camera, 'fov', 30, 100, 1).onChange(hooks.cameraProjectionChanged);
    c.add(TUNING.camera, 'orbitSensitivity', 0.0005, 0.01, 0.0001);
    c.add(TUNING.camera, 'followSharpness', 1, 40, 0.5);
    c.add(TUNING.camera, 'orbitSharpness', 1, 60, 0.5);
    c.add(TUNING.camera, 'zoomSharpness', 1, 40, 0.5);
    c.add(TUNING.camera, 'sniffBlendSharpness', 0.5, 20, 0.1);
    c.add(TUNING.camera, 'unblockSharpness', 0.5, 20, 0.1);
    c.add(TUNING.camera, 'collisionMargin', 0, 1, 0.01);
    c.add(TUNING.camera, 'recenterRate', 0, 6, 0.05).name('recenter rate (0=off)');
    c.add(TUNING.camera, 'recenterDelay', 0, 5, 0.1);
    c.add(TUNING.camera, 'recenterMaxAngle', 0, Math.PI, 0.05);
    c.add(TUNING.camera, 'minPitch', -0.5, 0.5, 0.01);
    c.add(TUNING.camera, 'maxPitch', 0.3, 1.5, 0.01);

    const vis = gui.addFolder('Dog animation').close();
    for (const k of Object.keys(TUNING.visual) as (keyof typeof TUNING.visual)[]) {
      vis.add(TUNING.visual, k, k.includes('Pitch') ? -2 : 0, k.startsWith('stride') ? 5 : k.startsWith('tail') ? 20 : 2, 0.005);
    }

    const m = gui.addFolder('Map streaming').close();
    m.add(TUNING.map, 'loadRadius', 150, 1200, 10).name('load radius (m)');
    m.add(TUNING.map, 'unloadRadius', 200, 1500, 10).name('unload radius (m)');
    m.add(TUNING.map, 'fogNearFraction', 0, 1, 0.01).name('fog start (× load radius)');
    m.add(TUNING.map, 'fogFarFraction', 0.2, 1.5, 0.01).name('fog end (× load radius)');
    m.add(TUNING.map, 'maxInFlight', 1, 16, 1).name('tile requests in flight');
    m.add(TUNING.map, 'maxFinalizePerFrame', 1, 8, 1).name('tiles finalized / frame');
    m.add(TUNING.map, 'textureSize', [256, 512, 1024, 2048]).name('ground texture px (new tiles)');
    m.add(TUNING.lighting, 'shadowRadius', 10, 200, 1).name('shadow range (m)').onFinishChange(hooks.shadowsChanged);
    m.add(TUNING.lighting, 'shadowMapSize', [512, 1024, 2048, 4096]).name('shadow map px').onFinishChange(hooks.shadowsChanged);

    const w = gui.addFolder('World / sim').close();
    w.add(TUNING.world, 'gravity', 1, 40, 0.1).name('gravity (m/s²)');
    w.add(TUNING.sim, 'tickRate', 20, 240, 1).name('sim Hz');
    w.add(TUNING.collision, 'iterations', 1, 8, 1).name('collision passes');
    w.add(TUNING.triggers, 'exitMargin', 0, 2, 0.05).name('trigger exit margin');
    w.add(TUNING.lighting, 'sunIntensity', 0, 6, 0.05);
    w.add(TUNING.lighting, 'hemiIntensity', 0, 4, 0.05);
    w.add(TUNING.debug, 'showTriggerZones').name('show trigger zones (T)').listen().onChange(hooks.triggerZonesToggled);

    gui.add({
      copy: () => {
        const text = `// TUNING\n${JSON.stringify(TUNING, null, 2)}\n// DogProfile '${profile.id}'\n${JSON.stringify(profile, null, 2)}`;
        navigator.clipboard?.writeText(text)
          .then(() => hooks.toast('Tuning values copied to clipboard'))
          .catch(() => {
            console.info(text);
            hooks.toast('Clipboard blocked — values printed to the console');
          });
      },
    }, 'copy').name('📋 Copy values (paste into config)');
  }

  toggle(): void {
    this.shown = !this.shown;
    this.gui.show(this.shown);
  }

  dispose(): void {
    this.gui.destroy();
  }
}
