/** HTML helpers shared by the site build and the reference renderer. */

export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/**
 * A labelled code block with a copy button. `lang` is validated because it is
 * used in markup; `label` is what the header shows and defaults to `lang`.
 */
export function renderCodeBlock(lang, raw, label = lang) {
  if (!/^[a-z0-9+#._-]*$/i.test(lang)) {
    throw new Error(`code-block lang "${lang}" has unexpected characters`);
  }
  const text = normalizeNewlines(raw).replace(/^\n+/, "").replace(/\s+$/, "");
  const shown = label || "text";
  return (
    `<div class="code">` +
    `<div class="code-head"><span class="code-lang">${escapeHtml(shown)}</span>` +
    `<button type="button" class="code-copy" aria-label="Copy ${escapeHtml(shown)} to clipboard">` +
    `<span class="code-copy-icon">${COPY_ICON}</span><span class="code-copy-label" aria-live="polite">copy</span></button></div>` +
    `<pre><code>${escapeHtml(text)}</code></pre></div>`
  );
}
