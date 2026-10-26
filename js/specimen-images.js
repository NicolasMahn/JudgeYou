// Builds replace the sprite path with its fingerprinted filename.
const sprite = typeof __SPECIMEN_SPRITE__ === 'undefined' ? 'img/specimens.svg' : __SPECIMEN_SPRITE__;

export function specimenOf(type) {
  return `${sprite}#${type}`;
}
