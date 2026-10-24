/**
 * Plugin-level model settings for Open Design turns that THIS side starts.
 *
 * Scope is deliberate and narrow: these values only steer runs the bridge
 * issues through `opendesign_ask`. They never touch Open Design's own
 * configuration, so a human changing the model in the Open Design window is
 * unaffected, and this setting is not "the current Open Design model" after the
 * first seeding — it is DSH's own standing choice.
 *
 * The values are seeded ONCE from Open Design at first use (the product
 * decision: "new install reads Open Design's current value once"), and are then
 * owned by this side until someone changes them here.
 *
 * Why a separate file instead of the Team bindings document: the Plugin Manager
 * detail page has no Session, so it cannot name a Team. One plugin-level
 * document is the only scope that page can honestly edit.
 *
 * @module @local/dsh-opendesign-member/lib/settings
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

/** Model id used when nothing has been chosen, matching the daemon's own default. */
export const DEFAULT_MODEL = 'default';

/** Provider segment of a `provider/model` id, or undefined when there is none. */
export function providerOf(modelId) {
  if (typeof modelId !== 'string') return undefined;
  const at = modelId.indexOf('/');
  // A bare `default` has no provider: it means "whatever the profile resolved".
  return at > 0 ? modelId.slice(0, at) : undefined;
}

/** Model segment of a `provider/model` id, or the id itself when bare. */
export function modelNameOf(modelId) {
  if (typeof modelId !== 'string') return '';
  const at = modelId.indexOf('/');
  return at > 0 ? modelId.slice(at + 1) : modelId;
}

/** Coerce any stored document into the typed shape, dropping unusable fields. */
function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const model = typeof source.model === 'string' && source.model.length > 0
    ? source.model
    : DEFAULT_MODEL;
  return {
    schemaVersion: SCHEMA_VERSION,
    model,
    // Empty string is a real state: "send no reasoning field, let the profile
    // decide". Null and a missing field both collapse to it.
    reasoning: typeof source.reasoning === 'string' && source.reasoning.length > 0
      ? source.reasoning
      : '',
    // When the one-time seeding actually happened. Absent means "never seeded",
    // which is what makes the first read of a fresh install copy Open Design's
    // current value instead of silently using a default.
    seededAt: Number.isFinite(source.seededAt) ? source.seededAt : null,
    seededFrom: typeof source.seededFrom === 'string' ? source.seededFrom : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

/** Read the settings document, tolerating absence and corrupt content. */
export function loadSettings(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalize({});
  }
}

/** Persist the settings document atomically (temp + rename). */
export function saveSettings(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(normalize(doc), null, 2)}\n`;
  fs.writeFileSync(temporary, payload, 'utf8');
  fs.renameSync(temporary, file);
  return normalize(doc);
}

/**
 * Small owner for the settings document.
 *
 * Reads are served from memory so a UI poll never touches the disk; every
 * mutation re-reads first, so an external edit is not silently clobbered.
 */
export class SettingsStore {
  /**
   * @param file - absolute path to the settings JSON document.
   */
  constructor(file) {
    this.file = file;
    this.doc = loadSettings(file);
  }

  /** Re-read from disk and return the current values. */
  reload() {
    this.doc = loadSettings(this.file);
    return this.doc;
  }

  /** Current values without touching the disk. */
  current() {
    return this.doc;
  }

  /** Whether the one-time seeding from Open Design has already happened. */
  get seeded() {
    return this.doc.seededAt !== null;
  }

  /**
   * Write the values a user chose here.
   *
   * @param patch - optional model and reasoning tier.
   */
  update(patch) {
    const onDisk = loadSettings(this.file);
    const next = normalize({
      ...onDisk,
      ...(typeof patch?.model === 'string' ? { model: patch.model } : {}),
      ...(patch?.reasoning === undefined ? {} : { reasoning: patch.reasoning }),
      // An explicit choice is by definition no longer "just seeded": the value
      // is now this side's own, so a later re-seed must not quietly overwrite it.
      seededAt: onDisk.seededAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    this.doc = saveSettings(this.file, next);
    return this.doc;
  }

  /**
   * Record the one-time seeding from Open Design's current selection.
   *
   * Only runs when never seeded; that is what makes seeding happen exactly once
   * rather than re-imposing Open Design's value on every launch.
   *
   * @param source - `agentModels[agentId]` payload: `{ model, reasoning? }`.
   * @param origin - human-readable note about where the value came from.
   */
  seedOnce(source, origin) {
    const onDisk = loadSettings(this.file);
    if (onDisk.seededAt !== null) {
      this.doc = onDisk;
      return { ...onDisk, seededNow: false };
    }
    const model = typeof source?.model === 'string' && source.model.length > 0
      ? source.model
      : DEFAULT_MODEL;
    const next = normalize({
      ...onDisk,
      model,
      reasoning: typeof source?.reasoning === 'string' ? source.reasoning : '',
      seededAt: Date.now(),
      seededFrom: typeof origin === 'string' ? origin : null,
      updatedAt: Date.now(),
    });
    this.doc = saveSettings(this.file, next);
    return { ...this.doc, seededNow: true };
  }
}

/**
 * Decide the `provider / model / reasoning` triple a turn should actually use,
 * and say plainly whether each stored value is still valid.
 *
 * A stored value that has left the catalogue is reported as invalid instead of
 * being silently replaced by the first option: the whole point of the error band
 * is that a wrong setting must be visible, not auto-corrected into a different
 * model than the human believes is running.
 *
 * @param settings - current settings document.
 * @param catalogue - flat entries: `[{ provider, id, label, reasoningOptions }]`,
 *   where `id` is the full `provider/model` id. The same model id may appear
 *   once per provider, and each row carries only the tiers THAT provider accepts.
 */
export function resolveSelection(settings, catalogue) {
  const problems = [];
  const stored = settings?.model ?? DEFAULT_MODEL;

  if (stored === DEFAULT_MODEL) {
    return {
      model: DEFAULT_MODEL,
      provider: null,
      modelName: DEFAULT_MODEL,
      reasoning: settings?.reasoning || '',
      reasoningOptions: [],
      problems,
    };
  }

  const entry = (catalogue ?? []).find((candidate) => candidate.id === stored);

  if (entry === undefined) {
    const provider = providerOf(stored);
    const name = modelNameOf(stored);
    problems.push(provider === undefined
      ? `model "${stored}" is no longer offered by any provider`
      : `model "${stored}" is no longer offered by provider "${provider}" (renamed, withdrawn, or its provider is unavailable)`);
    return {
      model: stored,
      provider: provider ?? null,
      modelName: name,
      reasoning: settings?.reasoning || '',
      reasoningOptions: [],
      problems,
    };
  }

  const options = Array.isArray(entry.reasoningOptions) ? entry.reasoningOptions : [];
  const chosen = settings?.reasoning || '';
  if (chosen.length > 0 && options.length > 0 && !options.some((option) => option.id === chosen)) {
    problems.push(
      `reasoning tier "${chosen}" is not accepted by ${entry.provider}/${modelNameOf(entry.id)} (accepts: ${options.map((option) => option.id).join(', ')})`,
    );
  }

  return {
    model: stored,
    provider: entry.provider ?? null,
    modelName: modelNameOf(entry.id),
    reasoning: chosen,
    reasoningOptions: options,
    problems,
  };
}
