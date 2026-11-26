/* Docs behaviour: theme toggle, mobile drawer, code-block copy buttons. */
(function () {
  var root = document.documentElement;
  var KEY = "fossel-theme";

  var MOON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  var SUN =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var COPY =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var CHECK =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  // Theme. The head script has already set data-theme; this wires the button.
  var toggle = document.querySelector("[data-theme-toggle]");
  function paintIcon() {
    if (toggle) toggle.innerHTML = root.getAttribute("data-theme") === "dark" ? MOON : SUN;
  }
  paintIcon();
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (_) {}
      paintIcon();
    });
  }

  // Mobile drawer.
  var body = document.body;
  var menuBtn = document.querySelector("[data-docs-menu]");
  var sidebar = document.getElementById("docs-sidebar");
  function setMenu(open) {
    body.classList.toggle("docs-menu-open", open);
    if (menuBtn) menuBtn.setAttribute("aria-expanded", String(open));
  }
  if (menuBtn && sidebar) {
    menuBtn.addEventListener("click", function () {
      setMenu(!body.classList.contains("docs-menu-open"));
    });
    document.querySelector(".docs-scrim").addEventListener("click", function () {
      setMenu(false);
    });
    sidebar.addEventListener("click", function (event) {
      if (event.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && body.classList.contains("docs-menu-open")) {
        setMenu(false);
        menuBtn.focus();
      }
    });
    // A resize past the breakpoint should not leave the drawer state behind.
    matchMedia("(min-width: 901px)").addEventListener("change", function (event) {
      if (event.matches) setMenu(false);
    });
  }

  // Code blocks: copy the <code> text. Falls back to selecting it when the
  // clipboard API is unavailable or refused (insecure context, no permission).
  document.addEventListener("click", function (event) {
    var button = event.target.closest(".code-copy");
    if (!button) return;
    var code = button.closest(".code").querySelector("pre code");
    var label = button.querySelector(".code-copy-label");
    var icon = button.querySelector(".code-copy-icon");

    function done(text, glyph) {
      label.textContent = text;
      icon.innerHTML = glyph;
      setTimeout(function () {
        label.textContent = "copy";
        icon.innerHTML = COPY;
      }, 1600);
    }

    function selectInstead() {
      var range = document.createRange();
      range.selectNodeContents(code);
      var selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      done("selected", COPY);
    }

    if (!navigator.clipboard) return selectInstead();
    navigator.clipboard.writeText(code.textContent).then(function () {
      done("copied", CHECK);
    }, selectInstead);
  });
})();
