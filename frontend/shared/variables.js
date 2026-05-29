/**
 * Variable resolution utility.
 *
 * Scope:
 * - Variables defined per environment: [{ key, value, isSecret }]
 * - Key-value substitution in strings
 *
 * Supported placeholders:
 * - ${VAR_NAME}
 * - {{VAR_NAME}}
 *
 * Escaping:
 * - \${VAR_NAME} -> ${VAR_NAME} (not substituted)
 * - \{{VAR_NAME}} -> {{VAR_NAME}} (not substituted)
 *
 * No recorder/replay integration.
 */

function toVarMap(env) {
  const map = new Map();
  const vars = Array.isArray(env?.variables) ? env.variables : [];
  for (const v of vars) {
    const key = String(v?.key || "").trim();
    if (!key) continue;
    const value = typeof v?.value === "string" ? v.value : String(v?.value ?? "");
    // Store both original and upper-case key for more forgiving lookups.
    map.set(key, value);
    map.set(key.toUpperCase(), value);
  }
  return map;
}

/**
 * Resolve placeholders in `text` using variables from `env`.
 *
 * @param {string} text
 * @param {{ variables?: Array<{ key: string, value: string, isSecret?: boolean }> }} env
 * @returns {string}
 */
export function resolveVariables(text, env) {
  if (text == null) return "";
  const input = String(text);
  const vars = toVarMap(env);

  // Handle escaped placeholders first by temporary sentinel.
  const ESC_DOLLAR = "__AUTOTEST_ESC_DOLLAR__";
  const ESC_CURLY = "__AUTOTEST_ESC_CURLY__";
  let s = input
    .replaceAll("\\${", ESC_DOLLAR)
    .replaceAll("\\{{", ESC_CURLY);

  // ${VAR_NAME}
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) => {
    const v = vars.get(key) ?? vars.get(String(key).toUpperCase());
    return v != null ? String(v) : m;
  });

  // {{VAR_NAME}}
  s = s.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (m, key) => {
    const v = vars.get(key) ?? vars.get(String(key).toUpperCase());
    return v != null ? String(v) : m;
  });

  // Unescape sentinels.
  s = s.replaceAll(ESC_DOLLAR, "${").replaceAll(ESC_CURLY, "{{");
  return s;
}

