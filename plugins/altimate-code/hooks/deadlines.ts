/**
 * How long one tool-chain phase may take, in milliseconds. Kept apart from the chain so a feature can
 * bound its own work inside it without importing the chain that imports the feature.
 */
export const PHASE_TIMEOUT_MS = 5_000
