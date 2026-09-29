// The SGP4 pieces of satellite.js, imported from its files directly.
//
// The package entry (`import ... from 'satellite.js'`) also re-exports a WebAssembly bulk propagator
// that pulls in top-level await and node: modules, which the renderer bundle cannot contain (and we
// do not need: the plain-JS propagator handles thousands of satellites per frame). Going around the
// entry leaves all of that out of the build.

export { json2satrec } from '../../../../node_modules/satellite.js/dist/io.js'
export { propagate } from '../../../../node_modules/satellite.js/dist/propagation/propagate.js'
export { gstime } from '../../../../node_modules/satellite.js/dist/propagation/gstime.js'
export { eciToEcf, eciToGeodetic, ecfToLookAngles, geodeticToEcf } from '../../../../node_modules/satellite.js/dist/transforms.js'
export { sunPos } from '../../../../node_modules/satellite.js/dist/sun.js'
export { shadowFraction } from '../../../../node_modules/satellite.js/dist/shadow.js'
export { jday } from '../../../../node_modules/satellite.js/dist/ext.js'
export type { SatRec } from '../../../../node_modules/satellite.js/dist/propagation/SatRec.js'
export type { EciVec3, GeodeticLocation, PositionAndVelocity } from '../../../../node_modules/satellite.js/dist/common-types.js'
