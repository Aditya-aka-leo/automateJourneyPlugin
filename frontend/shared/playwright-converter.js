/**
 * Playwright .spec.ts → Extension step converter.
 *
 * Parses common Playwright test patterns and emits step objects compatible
 * with the extension's `performStep()` / `runReplayOnTab()` replay engine.
 *
 * Supported selector types in the extension's _resolveInDocument():
 *   - css   → document.querySelectorAll(value)
 *   - text  → resolveByText(value)
 *   - xpath → document.evaluate(value)
 *
 * Playwright's getByRole / getByLabel / getByPlaceholder / getByText are
 * mapped to CSS or text selectors that the extension can resolve.
 */

// ─── Helpers ─────────────────────────────────────────────────────

/** Extract a string literal (single or double quoted) starting at `pos`. */
function _extractStringLiteral(code, pos) {
  const ch = code[pos];
  if (ch !== "'" && ch !== '"' && ch !== '`') return null;
  let i = pos + 1;
  let result = "";
  while (i < code.length) {
    if (code[i] === "\\") {
      result += code[i + 1] || "";
      i += 2;
      continue;
    }
    if (code[i] === ch) return { value: result, end: i + 1 };
    result += code[i];
    i++;
  }
  return null;
}

/** Extract a regex literal /pattern/flags starting at `pos`. */
function _extractRegexLiteral(code, pos) {
  if (code[pos] !== "/") return null;
  let i = pos + 1;
  let pattern = "";
  let inCharClass = false;
  while (i < code.length) {
    if (code[i] === "\\" && i + 1 < code.length) {
      pattern += code[i] + code[i + 1];
      i += 2;
      continue;
    }
    if (code[i] === "[") inCharClass = true;
    if (code[i] === "]") inCharClass = false;
    if (code[i] === "/" && !inCharClass) {
      i++; // skip closing /
      let flags = "";
      while (i < code.length && /[gimsuy]/.test(code[i])) {
        flags += code[i++];
      }
      return { pattern, flags, end: i };
    }
    pattern += code[i];
    i++;
  }
  return null;
}

/** Convert a regex-like pattern to a plain text string for assertions. */
function _regexToText(pattern) {
  // For alternation patterns (a|b), use just the first alternative
  if (pattern.includes("|")) {
    const firstAlt = pattern.split("|")[0];
    return firstAlt.replace(/[\\^$.*+?()[\]{}]/g, "").trim();
  }
  // Remove anchors and common meta-chars; keep literal text
  return pattern.replace(/[\\^$.*+?()[\]{}]/g, "").trim();
}

/** Build a selector object in the shape the extension expects. */
function _makeSelector(primary, fallbacks = []) {
  return { primary, fallbacks };
}

function _cssSelector(value) {
  return { type: "css", value };
}

function _textSelector(value) {
  return { type: "text", value };
}

// ─── Locator Parsing ─────────────────────────────────────────────

/**
 * Parse a Playwright locator chain (e.g. `page.getByRole('link', { name: 'Register' })`)
 * and return an extension-compatible selector object.
 */
function parseLocator(locatorCode) {
  let code = locatorCode.trim();

  // page.getByRole('role', { name: 'xxx' })
  {
    const m = code.match(
      /\.getByRole\(\s*['"]([^'"]+)['"]\s*(?:,\s*\{[^}]*name:\s*['"]([^'"]*)['"]\s*\})?/
    );
    if (m) {
      const role = m[1];
      const name = m[2] || "";
      const exact =
        /exact:\s*true/.test(code.match(/\.getByRole\([^)]*\)/)?.[0] || "");

      // Map ARIA roles to corresponding HTML elements for more robust matching
      const roleToTag = {
        button: "button",
        link: "a",
        heading: "h1,h2,h3,h4,h5,h6",
        textbox: "input[type='text'],input:not([type]),textarea",
        checkbox: "input[type='checkbox']",
        radio: "input[type='radio']",
        combobox: "select",
        img: "img",
        navigation: "nav",
        list: "ul,ol",
        listitem: "li",
      };

      const tagSelector = roleToTag[role] || "";
      const fallbacks = [];

      // Build selectors: prefer specific CSS that narrows by tag + text,
      // then fall back to text-based and broad CSS.
      let primary;
      if (name) {
        // Primary: xpath that matches the tag by text content (most precise)
        const tags = tagSelector || `*[role="${role}"]`;
        const firstTag = tags.split(",")[0].trim();
        const xpathExpr = firstTag.includes("[")
          ? `//${firstTag}[contains(normalize-space(.),"${name}")]`
          : `//${firstTag}[contains(normalize-space(.),"${name}")]`;
        primary = { type: "xpath", value: xpathExpr };
        // Fallbacks: text match, aria-label, broad role
        fallbacks.push(_textSelector(name));
        fallbacks.push(_cssSelector(`[aria-label="${name}"]`));
        if (tagSelector) fallbacks.push(_cssSelector(tagSelector));
        fallbacks.push(_cssSelector(`[role="${role}"]`));
      } else {
        primary = tagSelector
          ? _cssSelector(tagSelector)
          : _cssSelector(`[role="${role}"]`);
        fallbacks.push(_cssSelector(`[role="${role}"]`));
      }

      return {
        selector: _makeSelector(primary, fallbacks),
        elementName: name ? `${role}: ${name}` : role,
        _roleName: name,
        _role: role,
        _exact: exact,
      };
    }
  }

  // page.getByRole('role') — no name option
  {
    const m = code.match(/\.getByRole\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      return {
        selector: _makeSelector(_cssSelector(`[role="${m[1]}"]`)),
        elementName: m[1],
      };
    }
  }

  // page.getByLabel('xxx')
  {
    const m = code.match(/\.getByLabel\(\s*['"]([^'"]+)['"]/);
    if (m) {
      const label = m[1];
      const exact =
        /exact:\s*true/.test(code.match(/\.getByLabel\([^)]*\)/)?.[0] || "");
      // Find input/select/textarea associated with a <label> containing this text.
      // Use XPath as primary: //label[contains(text(),'Label')]/..//input | //label[contains(.,'Label')]//following::input[1]
      // Also try aria-label CSS and placeholder as fallbacks.
      // Build multiple xpaths: "following" sibling and "for" attribute approaches
      const xpathExpr = exact
        ? `//label[normalize-space(text())="${label}"]/following::*[self::input or self::select or self::textarea][1]`
        : `//label[contains(normalize-space(.),"${label}")]/following::*[self::input or self::select or self::textarea][1]`;
      // Common ID patterns: "FirstName", "first-name", "firstName", "first_name"
      const idVariants = [
        label.replace(/\s+/g, ""),               // "FirstName"
        label.replace(/\s+/g, "-").toLowerCase(), // "first-name"
        label.replace(/\s+/g, "_").toLowerCase(), // "first_name"
        label.charAt(0).toLowerCase() + label.replace(/\s+/g, "").slice(1), // "firstName"
      ];
      const idFallbacks = [...new Set(idVariants)].map(id => _cssSelector(`#${id}`));
      return {
        selector: _makeSelector(
          { type: "xpath", value: xpathExpr },
          [
            _cssSelector(`[aria-label="${label}"]`),
            _cssSelector(`[placeholder="${label}"]`),
            _cssSelector(`[name="${label}"]`),
            ...idFallbacks,
          ]
        ),
        elementName: label,
        _labelText: label,
        _exact: exact,
      };
    }
  }

  // page.getByPlaceholder('xxx')
  {
    const m = code.match(/\.getByPlaceholder\(\s*['"]([^'"]+)['"]/);
    if (m) {
      return {
        selector: _makeSelector(_cssSelector(`[placeholder="${m[1]}"]`)),
        elementName: m[1],
      };
    }
  }

  // page.getByText('xxx') or page.getByText(/regex/)
  {
    const m = code.match(/\.getByText\(\s*['"]([^'"]+)['"]/);
    if (m) {
      return {
        selector: _makeSelector(_textSelector(m[1])),
        elementName: m[1],
      };
    }
    // Regex variant
    const rm = code.match(/\.getByText\(\s*\//);
    if (rm) {
      const startIdx = code.indexOf("getByText(") + "getByText(".length;
      const rx = _extractRegexLiteral(code, startIdx);
      if (rx) {
        const text = _regexToText(rx.pattern);
        if (text) {
          return {
            selector: _makeSelector(_textSelector(text)),
            elementName: text,
          };
        }
      }
    }
  }

  // page.getByTestId('xxx')
  {
    const m = code.match(/\.getByTestId\(\s*['"]([^'"]+)['"]/);
    if (m) {
      return {
        selector: _makeSelector(_cssSelector(`[data-testid="${m[1]}"]`)),
        elementName: m[1],
      };
    }
  }

  // page.locator('selector')
  {
    const m = code.match(/\.locator\(\s*['"]([^'"]+)['"]/);
    if (m) {
      const sel = m[1];
      // Detect xpath
      if (sel.startsWith("//") || sel.startsWith("(//")) {
        return {
          selector: _makeSelector({ type: "xpath", value: sel }),
          elementName: sel.substring(0, 40),
        };
      }
      return {
        selector: _makeSelector(_cssSelector(sel)),
        elementName: sel.substring(0, 40),
      };
    }
  }

  return null;
}

// ─── Expect/Assertion Parsing ────────────────────────────────────

/**
 * Parse an `expect(...)` line and return an assertion step, or null.
 */
function parseExpect(line) {
  // expect(page).toHaveURL(...)
  {
    const m = line.match(/expect\(\s*page\s*\)\.toHaveURL\(\s*/);
    if (m) {
      const afterMatch = line.substring(m.index + m[0].length);
      // Regex: /pattern/
      if (afterMatch.startsWith("/")) {
        const rx = _extractRegexLiteral(afterMatch, 0);
        if (rx) {
          return {
            type: "assert_url_contains",
            value: _regexToText(rx.pattern),
            elementName: "URL assertion",
          };
        }
      }
      // String literal
      const str = _extractStringLiteral(afterMatch, 0);
      if (str) {
        return {
          type: "assert_url_contains",
          value: str.value,
          elementName: "URL assertion",
        };
      }
      // Template literal with variable
      if (afterMatch.startsWith("`")) {
        const str2 = _extractStringLiteral(afterMatch, 0);
        if (str2) {
          return {
            type: "assert_url_contains",
            value: str2.value,
            elementName: "URL assertion",
          };
        }
      }
    }
  }

  // expect(page).toHaveTitle(...)
  {
    const m = line.match(/expect\(\s*page\s*\)\.toHaveTitle\(\s*/);
    if (m) {
      const afterMatch = line.substring(m.index + m[0].length);
      if (afterMatch.startsWith("/")) {
        const rx = _extractRegexLiteral(afterMatch, 0);
        if (rx) {
          return {
            type: "assert_has_title",
            value: _regexToText(rx.pattern),
            elementName: "Title assertion",
            selector: _makeSelector(_cssSelector("body")),
          };
        }
      }
      const str = _extractStringLiteral(afterMatch, 0);
      if (str) {
        return {
          type: "assert_has_title",
          value: str.value,
          elementName: "Title assertion",
          selector: _makeSelector(_cssSelector("body")),
        };
      }
    }
  }

  // expect(locator).toBeVisible()
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toBeVisible\(\)/);
    if (m) {
      const loc = parseLocator(m[1]);
      if (loc) {
        return {
          type: "assert_visible",
          selector: loc.selector,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toHaveText(...)
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toHaveText\(\s*/);
    if (m) {
      const loc = parseLocator(m[1]);
      const afterMatch = line.substring(m.index + m[0].length);
      let value = "";
      const str = _extractStringLiteral(afterMatch, 0);
      if (str) value = str.value;
      else if (afterMatch.startsWith("/")) {
        const rx = _extractRegexLiteral(afterMatch, 0);
        if (rx) value = _regexToText(rx.pattern);
      }
      if (loc) {
        return {
          type: "assert_text_contains",
          selector: loc.selector,
          value,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toHaveValue(...)
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toHaveValue\(\s*/);
    if (m) {
      const loc = parseLocator(m[1]);
      const afterMatch = line.substring(m.index + m[0].length);
      let value = "";
      const str = _extractStringLiteral(afterMatch, 0);
      if (str) value = str.value;
      if (loc) {
        return {
          type: "assert_has_value",
          selector: loc.selector,
          value,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toBeChecked()
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toBeChecked\(\)/);
    if (m) {
      const loc = parseLocator(m[1]);
      if (loc) {
        return {
          type: "assert_checked",
          selector: loc.selector,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toBeEnabled()
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toBeEnabled\(\)/);
    if (m) {
      const loc = parseLocator(m[1]);
      if (loc) {
        return {
          type: "assert_enabled",
          selector: loc.selector,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toBeDisabled()
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toBeDisabled\(\)/);
    if (m) {
      const loc = parseLocator(m[1]);
      if (loc) {
        return {
          type: "assert_disabled",
          selector: loc.selector,
          elementName: loc.elementName,
        };
      }
    }
  }

  // expect(locator).toHaveAttribute(attr, value)
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toHaveAttribute\(\s*/);
    if (m) {
      const loc = parseLocator(m[1]);
      const afterMatch = line.substring(m.index + m[0].length);
      const attrStr = _extractStringLiteral(afterMatch, 0);
      if (loc && attrStr) {
        // Find the value after the comma
        const commaIdx = afterMatch.indexOf(",", attrStr.end);
        let attrValue = "";
        if (commaIdx >= 0) {
          const valStr = _extractStringLiteral(
            afterMatch,
            afterMatch.indexOf("'", commaIdx) >= 0
              ? afterMatch.indexOf("'", commaIdx)
              : afterMatch.indexOf('"', commaIdx)
          );
          if (valStr) attrValue = valStr.value;
        }
        return {
          type: "assert_attr_equals",
          selector: loc.selector,
          value: attrValue,
          elementName: loc.elementName,
          meta: { attr: attrStr.value },
        };
      }
    }
  }

  // expect(locator).toHaveClass(...)
  {
    const m = line.match(/expect\(\s*(.*?)\s*\)\.toHaveClass\(\s*/);
    if (m) {
      const loc = parseLocator(m[1]);
      const afterMatch = line.substring(m.index + m[0].length);
      const str = _extractStringLiteral(afterMatch, 0);
      if (loc && str) {
        return {
          type: "assert_has_class",
          selector: loc.selector,
          value: str.value,
          elementName: loc.elementName,
        };
      }
    }
  }

  return null;
}

// ─── Variable Resolution ─────────────────────────────────────────

/**
 * Extract `const/let/var X = 'literal'` declarations and build a map.
 */
function extractVariables(lines) {
  const vars = {};
  const timestampPlaceholder = String(Date.now());

  for (const line of lines) {
    const trimmed = line.trim();

    // const X = 'literal' or "literal"
    const simpleMatch = trimmed.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*(['"])(.*?)\2\s*;?\s*$/
    );
    if (simpleMatch) {
      vars[simpleMatch[1]] = simpleMatch[3];
      continue;
    }

    // const X = `template literal`
    const templateMatch = trimmed.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*`([^`]*)`\s*;?\s*$/
    );
    if (templateMatch) {
      let val = templateMatch[2];
      // Resolve ${expr} — substitute known vars or use placeholders
      val = val.replace(/\$\{([^}]+)\}/g, (_, expr) => {
        const varName = expr.trim();
        if (vars[varName]) return vars[varName];
        if (/Date\.now\(\)/.test(expr)) return timestampPlaceholder;
        return timestampPlaceholder; // fallback for unknown expressions
      });
      vars[templateMatch[1]] = val;
      continue;
    }

    // const X = expr (just Date.now())
    const exprMatch = trimmed.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*Date\.now\(\)\s*;?\s*$/
    );
    if (exprMatch) {
      vars[exprMatch[1]] = timestampPlaceholder;
    }
  }

  return vars;
}

/**
 * Substitute known variable references in a string argument.
 */
function resolveValue(rawValue, vars) {
  if (!rawValue) return rawValue;
  // Check if it's a bare variable name
  if (vars[rawValue] !== undefined) return vars[rawValue];
  return rawValue;
}

/**
 * Pre-process a line: replace bare variable references in function arguments
 * with their resolved string literals.  e.g. `.getByText(uniqueEmail)` →
 * `.getByText('resolved_value')` and `.fill(testPassword)` →
 * `.fill('resolved_value')`.  Also resolves template literals with variables.
 */
function resolveVarsInLine(line, vars) {
  if (!vars || Object.keys(vars).length === 0) return line;

  // Replace bare variable args: .method(varName) → .method('value')
  let result = line.replace(
    /(\.\w+\(\s*)(\b[a-zA-Z_]\w*\b)(\s*\))/g,
    (match, before, varName, after) => {
      if (vars[varName] !== undefined) {
        return `${before}'${vars[varName]}'${after}`;
      }
      return match;
    }
  );

  // Replace template literals: `${varName}...` with resolved values
  result = result.replace(/`([^`]*)`/g, (match, content) => {
    const resolved = content.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const v = expr.trim();
      return vars[v] || v;
    });
    return `'${resolved}'`;
  });

  return result;
}

// ─── Main Converter ──────────────────────────────────────────────

/**
 * Convert a Playwright .spec.ts file's source code into an array of
 * extension-compatible step objects.
 *
 * @param {string} specCode  Full source of the .spec.ts file
 * @param {string} baseUrl   Target URL from metadata (e.g. "https://example.com")
 * @returns {{ steps: object[], warnings: string[] }}
 */
export function playwrightToSteps(specCode, baseUrl) {
  const lines = specCode.split("\n");
  const warnings = [];
  const vars = extractVariables(lines);

  // Extract test.beforeEach / test.beforeAll blocks — their lines get
  // prepended to the selected test block so that setup steps (e.g. page.goto)
  // are included in the converted output.
  const beforeEachLines = [];
  {
    let inBefore = false;
    let bDepth = 0;
    let bodyStarted = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!inBefore && /test\.before(?:Each|All)\s*\(/.test(trimmed)) {
        inBefore = true;
        bDepth = 0;
        bodyStarted = false;
      }
      if (inBefore) {
        for (const ch of trimmed) {
          if (ch === "{") { bDepth++; bodyStarted = true; }
          if (ch === "}") bDepth--;
        }
        // Collect lines inside the body (after the opening brace)
        if (bodyStarted && bDepth > 0) {
          beforeEachLines.push(lines[i]);
        }
        if (bodyStarted && bDepth <= 0) {
          inBefore = false;
        }
      }
    }
  }

  // Find all test() blocks
  const testBlocks = [];
  let currentTestName = null;
  let depth = 0;
  let blockStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Detect test('name', ...) start — but skip test.describe, test.beforeEach, etc.
    const testMatch = trimmed.match(
      /test\s*\(\s*['"]([^'"]+)['"]/
    );
    if (testMatch && depth === 0) {
      currentTestName = testMatch[1];
      blockStartLine = i;
      depth = 0;
    }

    if (currentTestName !== null) {
      // Count braces
      for (const ch of trimmed) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }

      if (depth <= 0 && blockStartLine >= 0) {
        testBlocks.push({
          name: currentTestName,
          startLine: blockStartLine,
          endLine: i,
        });
        currentTestName = null;
        blockStartLine = -1;
        depth = 0;
      }
    }
  }

  if (testBlocks.length === 0) {
    warnings.push("No test() blocks found in spec file.");
    return { steps: [], warnings };
  }

  if (testBlocks.length > 1) {
    warnings.push(
      `Converting all ${testBlocks.length} test blocks for browser replay.`
    );
  }

  // Helper: join multi-line statements into single logical lines
  function joinMultilineStatements(rawLines) {
    const result = [];
    let pending = "";
    let parenDepth = 0;
    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (!pending && !trimmed.startsWith("await") && !trimmed.startsWith("expect")) {
        if (parenDepth > 0) {
          pending += " " + trimmed;
          for (const ch of trimmed) {
            if (ch === "(") parenDepth++;
            if (ch === ")") parenDepth--;
          }
          if (parenDepth <= 0) {
            result.push(pending);
            pending = "";
            parenDepth = 0;
          }
          continue;
        }
        result.push(raw);
        continue;
      }
      if (pending && parenDepth > 0) {
        pending += " " + trimmed;
      } else {
        pending = trimmed;
        parenDepth = 0;
      }
      for (const ch of trimmed) {
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;
      }
      if (parenDepth <= 0) {
        result.push(pending);
        pending = "";
        parenDepth = 0;
      }
    }
    if (pending) result.push(pending);
    return result;
  }

  const steps = [];
  let baseUrlObj;
  try {
    baseUrlObj = new URL(baseUrl);
  } catch {
    baseUrlObj = null;
  }

  // Process ALL test blocks — prepend beforeEach lines to each
  for (let blockIdx = 0; blockIdx < testBlocks.length; blockIdx++) {
    const block = testBlocks[blockIdx];
    const rawBlockLines = [...beforeEachLines, ...lines.slice(block.startLine, block.endLine + 1)];
    const blockLines = joinMultilineStatements(rawBlockLines);

  for (let i = 0; i < blockLines.length; i++) {
    const line = resolveVarsInLine(blockLines[i].trim(), vars);

    // Skip non-await lines, structural lines, comments
    if (!line.startsWith("await") && !line.startsWith("expect")) {
      continue;
    }

    // ── Skip lines that the replay engine handles implicitly ──
    if (
      /\.waitForLoadState\(/.test(line) ||
      /\.waitForURL\(/.test(line) ||
      /\.screenshot\(/.test(line)
    ) {
      continue;
    }

    // ── page.goto(url) → navigation ──
    {
      const m = line.match(/page\.goto\(\s*/);
      if (m) {
        const afterGoto = line.substring(m.index + m[0].length);
        let url = "";
        const str = _extractStringLiteral(afterGoto, 0);
        if (str) {
          url = str.value;
        } else if (afterGoto.startsWith("`")) {
          // Template literal: resolve variables
          const tpl = _extractStringLiteral(afterGoto, 0);
          if (tpl) {
            url = tpl.value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
              const v = expr.trim();
              return vars[v] || baseUrl || v;
            });
          }
        } else {
          // Bare variable reference: BASE_URL  or  BASE_URL + '/path'
          const varMatch = afterGoto.match(/^(\w+)\s*(?:\+\s*['"]([^'"]*)['"]\s*)?\)/);
          if (varMatch) {
            const base = vars[varMatch[1]] || baseUrl || varMatch[1];
            const suffix = varMatch[2] || "";
            url = base + suffix;
          }
          // Also handle `${VAR}/path` template
          const tplMatch = afterGoto.match(/^`\$\{(\w+)\}([^`]*)`/);
          if (!url && tplMatch) {
            url = (vars[tplMatch[1]] || baseUrl || "") + tplMatch[2];
          }
        }

        // If URL still contains unresolved ${...} or looks invalid, fall back to baseUrl
        if (!url || /\$\{/.test(url)) {
          // Extract any path suffix after the variable reference
          const pathMatch = url?.match(/\$\{[^}]+\}(.*)/);
          const pathSuffix = pathMatch?.[1] || "";
          url = (baseUrl || "") + pathSuffix;
        }

        if (url) {
          let relativePath = url;
          let queryParams = {};
          try {
            const parsed = new URL(url);
            relativePath = parsed.pathname;
            queryParams = Object.fromEntries(parsed.searchParams);
          } catch {
            // Might be a relative path already
            if (url.startsWith("/")) {
              const qIdx = url.indexOf("?");
              if (qIdx >= 0) {
                relativePath = url.substring(0, qIdx);
                queryParams = Object.fromEntries(
                  new URLSearchParams(url.substring(qIdx))
                );
              }
            }
          }
          steps.push({
            type: "navigation",
            relativePath,
            queryParams,
            elementName: `Navigate to ${relativePath}`,
            timestamp: Date.now(),
            meta: {},
          });
        }
        continue;
      }
    }

    // ── page.waitForTimeout(ms) → wait_delay ──
    {
      const m = line.match(/page\.waitForTimeout\(\s*(\d+)\s*\)/);
      if (m) {
        steps.push({
          type: "wait_delay",
          value: parseInt(m[1], 10),
          elementName: `Wait ${m[1]}ms`,
          timestamp: Date.now(),
          meta: {},
        });
        continue;
      }
    }

    // ── page.keyboard.press('Key') → keypress ──
    {
      const m = line.match(/page\.keyboard\.press\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m) {
        steps.push({
          type: "keypress",
          elementName: `Press ${m[1]}`,
          timestamp: Date.now(),
          meta: { key: m[1] },
          selector: null,
        });
        continue;
      }
    }

    // ── expect(...) assertions ──
    if (line.includes("expect(")) {
      const assertStep = parseExpect(line);
      if (assertStep) {
        steps.push({
          timestamp: Date.now(),
          meta: {},
          ...assertStep,
        });
        continue;
      }
    }

    // ── Locator actions: .click(), .fill(), .check(), .uncheck(), .selectOption(), .hover(), .press() ──
    {
      // Extract locator portion (everything before the final action call)
      const actionMatch = line.match(
        /await\s+(.*?)\.(click|fill|check|uncheck|selectOption|hover|press|type|dblclick|setInputFiles)\(/
      );
      if (actionMatch) {
        const locatorCode = actionMatch[1];
        const action = actionMatch[2];
        const loc = parseLocator(locatorCode);

        if (loc) {
          const afterAction = line.substring(
            line.indexOf(`.${action}(`) + action.length + 2
          );

          switch (action) {
            case "click":
            case "dblclick": {
              steps.push({
                type: "click",
                selector: loc.selector,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: action === "dblclick" ? { dblclick: true } : {},
              });
              break;
            }

            case "fill":
            case "type": {
              let value = "";
              const str = _extractStringLiteral(afterAction, 0);
              if (str) {
                value = resolveValue(str.value, vars);
              } else {
                // Variable reference
                const varRef = afterAction.match(/^(\w+)\s*\)/);
                if (varRef) value = vars[varRef[1]] || varRef[1];
              }
              steps.push({
                type: "input",
                selector: loc.selector,
                value,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: {},
              });
              break;
            }

            case "check": {
              steps.push({
                type: "click",
                selector: loc.selector,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: { forceCheck: true },
              });
              break;
            }

            case "uncheck": {
              steps.push({
                type: "click",
                selector: loc.selector,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: { forceUncheck: true },
              });
              break;
            }

            case "selectOption": {
              let value = "";
              const str = _extractStringLiteral(afterAction, 0);
              if (str) value = str.value;
              steps.push({
                type: "select",
                selector: loc.selector,
                value,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: {},
              });
              break;
            }

            case "hover": {
              steps.push({
                type: "hover",
                selector: loc.selector,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: {},
              });
              break;
            }

            case "press": {
              let key = "";
              const str = _extractStringLiteral(afterAction, 0);
              if (str) key = str.value;
              steps.push({
                type: "keypress",
                selector: loc.selector,
                elementName: loc.elementName,
                timestamp: Date.now(),
                meta: { key },
              });
              break;
            }

            case "setInputFiles": {
              warnings.push(
                `File upload step skipped (cannot replay file uploads in browser): ${line.substring(0, 80)}`
              );
              break;
            }
          }
          continue;
        }
      }
    }

    // Line not recognized — skip silently for common patterns, warn for others
    if (
      line.startsWith("await page.") ||
      line.startsWith("await expect") ||
      line.startsWith("expect(")
    ) {
      warnings.push(`Unrecognized line skipped: ${line.substring(0, 100)}`);
    }
  }

  // Ensure first step is a navigation if none exists
  if (steps.length > 0 && steps[0].type !== "navigation" && baseUrl) {
    let relativePath = "/";
    let queryParams = {};
    if (baseUrlObj) {
      relativePath = baseUrlObj.pathname;
      queryParams = Object.fromEntries(baseUrlObj.searchParams);
    }
    steps.unshift({
      type: "navigation",
      relativePath,
      queryParams,
      elementName: `Navigate to ${relativePath}`,
      timestamp: Date.now(),
      meta: {},
    });
  }
  } // end of for (blockIdx) loop over all test blocks

  return { steps, warnings };
}

// ─── Reverse converter: Extension steps → Playwright code ────────────

/**
 * Convert an array of extension step objects into a Playwright test script.
 *
 * @param {Array} steps  – step objects (from recordings or AI conversion)
 * @param {string} testName – name for the test block
 * @param {string} baseUrl  – base URL (used for page.goto)
 * @returns {string} Playwright .spec.ts code
 */
export function stepsToPlaywright(steps, testName = 'Recorded test', baseUrl = '') {
  if (!steps || !steps.length) return '';

  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test('${testName.replace(/'/g, "\\'")}', async ({ page }) => {`);

  for (const step of steps) {
    const line = _stepToPlaywrightLine(step, baseUrl);
    if (line) lines.push(`  ${line}`);
  }

  lines.push(`});`);
  lines.push('');
  return lines.join('\n');
}

function _stepToPlaywrightLine(step, baseUrl) {
  const type = step.type || '';

  // Navigation
  if (type === 'navigation') {
    const path = step.relativePath || step.value || step.meta?.url || '/';
    const url = path.startsWith('http') ? `'${path}'` : `'${baseUrl}${path}'`;
    return `await page.goto(${url});`;
  }

  // Build locator string from selector
  const locator = _selectorToLocator(step);

  // Click
  if (type === 'click') {
    if (step.meta?.dblclick) return `await ${locator}.dblclick();`;
    return `await ${locator}.click();`;
  }

  // Input / fill
  if (type === 'input' || type === 'fill') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await ${locator}.fill('${val.replace(/'/g, "\\'")}');`;
  }

  // Select
  if (type === 'select' || type === 'selectOption') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await ${locator}.selectOption('${val.replace(/'/g, "\\'")}');`;
  }

  // Check / uncheck
  if (type === 'check') return `await ${locator}.check();`;
  if (type === 'uncheck') return `await ${locator}.uncheck();`;

  // Hover
  if (type === 'hover') return `await ${locator}.hover();`;

  // Keyboard
  if (type === 'keypress' || type === 'keyboard') {
    const key = step.value || step.meta?.key || 'Enter';
    return `await page.keyboard.press('${key}');`;
  }

  // Wait
  if (type === 'wait') {
    const ms = step.value || step.meta?.timeout || 1000;
    return `await page.waitForTimeout(${ms});`;
  }

  // Assertions
  if (type === 'assert_visible') return `await expect(${locator}).toBeVisible();`;
  if (type === 'assert_text') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await expect(${locator}).toHaveText('${val.replace(/'/g, "\\'")}');`;
  }
  if (type === 'assert_value') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await expect(${locator}).toHaveValue('${val.replace(/'/g, "\\'")}');`;
  }
  if (type === 'assert_url') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await expect(page).toHaveURL(/${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/);`;
  }
  if (type === 'assert_title') {
    const val = typeof step.value === 'string' ? step.value : '';
    return `await expect(page).toHaveTitle('${val.replace(/'/g, "\\'")}');`;
  }
  if (type === 'assert_checked') return `await expect(${locator}).toBeChecked();`;
  if (type === 'assert_enabled') return `await expect(${locator}).toBeEnabled();`;
  if (type === 'assert_disabled') return `await expect(${locator}).toBeDisabled();`;
  if (type === 'assert_attribute') {
    const attr = step.meta?.attribute || 'class';
    const val = typeof step.value === 'string' ? step.value : '';
    return `await expect(${locator}).toHaveAttribute('${attr}', '${val.replace(/'/g, "\\'")}');`;
  }

  // Fallback: add as comment
  const desc = step.elementName || step.type || 'unknown step';
  return `// ${desc}`;
}

function _selectorToLocator(step) {
  const sel = step.selector?.primary;
  if (!sel) {
    // Try to build from elementName
    if (step.elementName) return `page.getByText('${step.elementName.replace(/'/g, "\\'")}')`;
    return `page.locator('body')`;
  }

  const val = sel.value || '';

  if (sel.type === 'text') {
    return `page.getByText('${val.replace(/'/g, "\\'")}')`;
  }
  if (sel.type === 'xpath') {
    return `page.locator('xpath=${val}')`;
  }
  // css (default)
  // Try to detect role-like patterns for cleaner output
  if (val.startsWith('[data-testid="') || val.startsWith('[data-testid=\'')) {
    const testId = val.match(/data-testid=["']([^"']+)["']/)?.[1];
    if (testId) return `page.getByTestId('${testId}')`;
  }
  if (val.startsWith('[placeholder="') || val.startsWith('[placeholder=\'')) {
    const ph = val.match(/placeholder=["']([^"']+)["']/)?.[1];
    if (ph) return `page.getByPlaceholder('${ph}')`;
  }
  if (val.match(/^(button|a|input|select|textarea)$/i)) {
    return `page.locator('${val}')`;
  }
  return `page.locator('${val.replace(/'/g, "\\'")}')`;
}
