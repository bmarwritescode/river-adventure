import type { LandmarkInfo, TileBuilding } from '../../types';
import type { DressContext } from '../houses';
import { buildHomeSlice } from './homeSlice';

/**
 * Hand-made hero locations (see tools/map/landmarks.py for the site plans). Each landmark replaces the
 * generic dressed building with its own model, built in the landmark frame the pipeline provides.
 */
export function buildLandmarkBuilding(ctx: DressContext, b: TileBuilding, lm: LandmarkInfo): void {
  switch (lm.id) {
    case 'homeslice':
      buildHomeSlice(ctx, b, lm);
      break;
  }
}
