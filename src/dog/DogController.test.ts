import { describe, expect, it } from 'vitest';
import { MAIN_DOG, type DogProfile } from '../config/dogProfiles';
import { CollisionWorld } from '../world/collision';
import { DogController, type DogIntent } from './DogController';

const DT = 1 / 60;
const none = (): DogIntent => ({ moveX: 0, moveZ: 0, pace: 'trot', sniff: false, jump: false, sit: false, playBow: false });
const profile = (over: Partial<DogProfile['behavior']> = {}): DogProfile =>
  structuredClone({ ...MAIN_DOG, behavior: { ...MAIN_DOG.behavior, ...over } });

function run(dog: DogController, seconds: number, intent: Partial<DogIntent> = {}): void {
  for (let t = 0; t < seconds; t += DT) dog.step(DT, { ...none(), ...intent });
}
function press(dog: DogController, key: 'sit' | 'playBow' | 'jump'): void {
  dog.step(DT, { ...none(), [key]: true });
}

describe('DogController actions (sit / play bow)', () => {
  const make = (over: Partial<DogProfile['behavior']> = {}) => {
    const dog = new DogController(profile({ autoSitAfter: 0, ...over }), new CollisionWorld());
    dog.teleport(0, 0, 0);
    return dog;
  };

  it('sits when stopped and stands up on a second press', () => {
    const dog = make();
    press(dog, 'sit');
    expect(dog.state).toBe('sit');
    run(dog, 1);
    expect(dog.state).toBe('sit');
    press(dog, 'sit');
    expect(dog.state).toBe('idle');
  });

  it('brakes to a stop before sitting when asked while moving', () => {
    const dog = make();
    run(dog, 1.5, { moveZ: -1, pace: 'run' }); // running north
    expect(dog.speed).toBeGreaterThan(5);
    press(dog, 'sit');
    expect(dog.state).not.toBe('sit'); // still moving
    run(dog, 3);
    expect(dog.state).toBe('sit');
    expect(dog.speed).toBeLessThan(0.3);
  });

  it("doesn't move while sitting; movement input stands it up after a short delay", () => {
    const dog = make();
    press(dog, 'sit');
    const z0 = dog.position.z;
    run(dog, 0.2, { moveZ: -1 }); // input cancels the sit, then the stand-up delay holds the dog
    expect(dog.state).not.toBe('sit');
    expect(Math.abs(dog.position.z - z0)).toBeLessThan(0.05);
    run(dog, 1, { moveZ: -1 });
    expect(dog.position.z).toBeLessThan(z0 - 1); // moving north after standing up
  });

  it('holds a play bow for its duration, then returns to idle', () => {
    const dog = make({ playBowDuration: 1 });
    press(dog, 'playBow');
    expect(dog.state).toBe('playBow');
    run(dog, 0.8);
    expect(dog.state).toBe('playBow');
    run(dog, 0.4);
    expect(dog.state).toBe('idle');
  });

  it('goes from sitting straight into a play bow (getting up first)', () => {
    const dog = make();
    press(dog, 'sit');
    press(dog, 'playBow');
    run(dog, MAIN_DOG.behavior.standUpTime + 0.1);
    expect(dog.state).toBe('playBow');
  });

  it("can't jump while sitting (the press just stands it up)", () => {
    const dog = make();
    press(dog, 'sit');
    press(dog, 'jump');
    expect(dog.state).toBe('idle');
    expect(dog.grounded).toBe(true);
  });

  it('sits by itself after idling for autoSitAfter seconds', () => {
    const dog = make({ autoSitAfter: 2 });
    run(dog, 1.9);
    expect(dog.state).toBe('idle');
    run(dog, 0.2);
    expect(dog.state).toBe('sit');
  });
});
