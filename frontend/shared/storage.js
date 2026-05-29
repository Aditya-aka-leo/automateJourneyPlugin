/**
 * chrome.storage.local utility layer (MV3-friendly).
 *
 * Goals:
 * - Small wrapper around chrome.storage.local with:
 *   - get(key)
 *   - set(key, value)
 *   - update(key, updaterFn)
 * - Versioned schema support via a single root object:
 *   {
 *     schemaVersion: number,
 *     data: Record<string, any>
 *   }
 *
 * Notes:
 * - chrome.storage.local is not transactional; update() is best-effort read/modify/write.
 * - Values should be JSON-serializable for portability.
 */

function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

function deepClone(value) {
  // Prefer structuredClone when available; fallback to JSON clone.
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export class StorageSchemaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "StorageSchemaError";
    this.details = details;
  }
}

/**
 * Creates a versioned key/value store backed by a single chrome.storage.local root key.
 *
 * @param {object} params
 * @param {string} params.rootKey - The chrome.storage.local key that stores the entire root object.
 * @param {number} params.schemaVersion - Current schema version for the root object.
 * @param {(root: any) => any} [params.migrate] - Optional migration function invoked when schemaVersion mismatches.
 *
 * @returns {{
 *   rootKey: string,
 *   schemaVersion: number,
 *   get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void>,
 *   update: (key: string, updaterFn: (current: any) => any | Promise<any>) => Promise<any>,
 *   getRoot: () => Promise<{ schemaVersion: number, data: Record<string, any> }>,
 *   setRoot: (root: { schemaVersion: number, data: Record<string, any> }) => Promise<void>
 * }}
 */
export function createVersionedStore({ rootKey, schemaVersion, migrate } = {}) {
  assertNonEmptyString("rootKey", rootKey);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError("schemaVersion must be an integer >= 1");
  }
  if (migrate != null) assertFunction("migrate", migrate);

  function defaultRoot() {
    return { schemaVersion, data: {} };
  }

  async function loadRoot() {
    const result = await chrome.storage.local.get(rootKey);
    const raw = result?.[rootKey];

    if (!raw || typeof raw !== "object") return defaultRoot();

    let root = raw;
    if (!Number.isInteger(root.schemaVersion) || typeof root.data !== "object" || !root.data) {
      throw new StorageSchemaError("Invalid root shape in storage", { rootKey, raw });
    }

    if (root.schemaVersion !== schemaVersion) {
      if (!migrate) {
        throw new StorageSchemaError("Schema version mismatch and no migrate() provided", {
          rootKey,
          storedVersion: root.schemaVersion,
          expectedVersion: schemaVersion
        });
      }

      const migrated = await migrate(deepClone(root));
      if (!migrated || typeof migrated !== "object") {
        throw new StorageSchemaError("migrate() must return an object root", { rootKey, migrated });
      }
      if (!Number.isInteger(migrated.schemaVersion) || typeof migrated.data !== "object" || !migrated.data) {
        throw new StorageSchemaError("migrate() returned invalid root shape", { rootKey, migrated });
      }
      if (migrated.schemaVersion !== schemaVersion) {
        throw new StorageSchemaError("migrate() must set schemaVersion to current", {
          rootKey,
          got: migrated.schemaVersion,
          expected: schemaVersion
        });
      }

      root = migrated;
      await chrome.storage.local.set({ [rootKey]: root });
    }

    return root;
  }

  async function saveRoot(root) {
    if (!root || typeof root !== "object") {
      throw new TypeError("root must be an object");
    }
    if (!Number.isInteger(root.schemaVersion)) {
      throw new TypeError("root.schemaVersion must be an integer");
    }
    if (!root.data || typeof root.data !== "object") {
      throw new TypeError("root.data must be an object");
    }
    await chrome.storage.local.set({ [rootKey]: root });
  }

  async function get(key) {
    assertNonEmptyString("key", key);
    const root = await loadRoot();
    return deepClone(root.data[key]);
  }

  async function set(key, value) {
    assertNonEmptyString("key", key);
    const root = await loadRoot();
    root.data[key] = deepClone(value);
    await saveRoot(root);
  }

  async function update(key, updaterFn) {
    assertNonEmptyString("key", key);
    assertFunction("updaterFn", updaterFn);

    const root = await loadRoot();
    const current = deepClone(root.data[key]);
    const next = await updaterFn(current);
    root.data[key] = deepClone(next);
    await saveRoot(root);
    return deepClone(next);
  }

  return {
    rootKey,
    schemaVersion,
    get,
    set,
    update,
    getRoot: async () => deepClone(await loadRoot()),
    setRoot: async (root) => saveRoot(deepClone(root))
  };
}

