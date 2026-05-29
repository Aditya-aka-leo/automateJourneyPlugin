/**
 * Flow metadata + versioning helpers.
 *
 * Each flow:
 * - name
 * - versions[] (preserved history)
 *
 * Each version:
 * - version (semantic)
 * - author
 * - createdAt
 * - updatedAt
 * - changelog
 * - steps
 */

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `flow_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export function isSemver(value) {
  const s = String(value || "").trim();
  // Basic semver: major.minor.patch with optional pre-release/build.
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(s);
}

export function createFlow({ name, version, author, changelog, steps }) {
  if (!String(name || "").trim()) {
    throw new Error("Flow name is required.");
  }
  if (!isSemver(version)) {
    throw new Error("Flow version must be semantic (e.g. 1.0.0).");
  }
  if (!String(author || "").trim()) {
    throw new Error("Flow author is required.");
  }
  const ts = nowIso();
  return {
    id: newId(),
    name: String(name || "").trim(),
    createdAt: ts,
    updatedAt: ts,
    versions: [
      {
        version: String(version || "").trim(),
        author: String(author || "").trim(),
        createdAt: ts,
        updatedAt: ts,
        changelog: String(changelog || "").trim(),
        steps: Array.isArray(steps) ? steps : []
      }
    ]
  };
}

export function addFlowVersion(flow, { version, author, changelog, steps }) {
  if (!flow || typeof flow !== "object") {
    throw new Error("Flow not found.");
  }
  if (!isSemver(version)) {
    throw new Error("Flow version must be semantic (e.g. 1.0.0).");
  }
  if (!String(author || "").trim()) {
    throw new Error("Flow author is required.");
  }
  const exists = flow.versions?.some((v) => v.version === String(version).trim());
  if (exists) {
    throw new Error(`Flow version "${version}" already exists.`);
  }
  const ts = nowIso();
  const newVersion = {
    version: String(version || "").trim(),
    author: String(author || "").trim(),
    createdAt: ts,
    updatedAt: ts,
    changelog: String(changelog || "").trim(),
    steps: Array.isArray(steps) ? steps : []
  };
  flow.versions = Array.isArray(flow.versions) ? [...flow.versions, newVersion] : [newVersion];
  flow.updatedAt = ts;
  return flow;
}

export function getLatestVersion(flow) {
  if (!flow || !Array.isArray(flow.versions) || flow.versions.length === 0) return null;
  return flow.versions[flow.versions.length - 1];
}

