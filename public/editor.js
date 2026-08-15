// VSCode-style (Monaco) editors for multiline fields, themed black & white.
// Backed by the trimmed bundle in public/vendor/editor/ (see scripts/build-editor.mjs).
// Each target <textarea data-editor> is kept in the DOM (hidden) as the source
// of truth: its `value` / `readOnly` properties are overridden to route to and
// from the Monaco instance, so existing app.js code keeps working unchanged.
(function () {
  'use strict';

  if (typeof window.monaco === 'undefined') return;

  window.MonacoEnvironment = {
    getWorkerUrl: function () {
      return 'vendor/editor/editor.worker.js';
    },
  };

  try {
    monaco.editor.defineTheme('at-field-dark', {
      base: 'vs-dark',
      inherit: false,
      rules: [
        { token: 'comment', foreground: '6B6B6B', fontStyle: 'italic' },
        { token: 'string', foreground: 'D4D4D4' },
        { token: 'keyword', foreground: 'FFFFFF', fontStyle: 'bold' },
        { token: 'number', foreground: 'B5B5B5' },
        { token: 'type', foreground: 'A0A0A0' },
        { token: 'identifier', foreground: 'FFFFFF' },
        { token: 'delimiter', foreground: '9A9A9A' },
        { token: 'operator', foreground: 'F0F0F0' },
        { token: 'predefined', foreground: 'E0E0E0' },
      ],
      colors: {
        'editor.background': '#000000',
        'editor.foreground': '#FFFFFF',
        'editor.lineHighlightBackground': '#0A0A0A',
        'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': '#3F3F3F',
        'editorLineNumber.activeForeground': '#FFFFFF',
        'editorCursor.foreground': '#FFFFFF',
        'editor.selectionBackground': '#3A3A3A',
        'editor.inactiveSelectionBackground': '#2A2A2A',
        'editor.selectionHighlightBackground': '#3A3A3A',
        'editorIndentGuide.background1': '#141414',
        'editorIndentGuide.activeBackground1': '#2A2A2A',
        'editorWidget.background': '#0A0A0A',
        'editorWidget.border': '#2A2A2A',
        'editorWidget.foreground': '#FFFFFF',
        'editorSuggestWidget.background': '#0A0A0A',
        'editorSuggestWidget.border': '#2A2A2A',
        'editorSuggestWidget.selectedBackground': '#333333',
        'editorHoverWidget.background': '#0A0A0A',
        'editorHoverWidget.border': '#2A2A2A',
        'editor.findMatchBackground': '#4A4A4A',
        'editor.findMatchHighlightBackground': '#3A3A3A',
        'scrollbarSlider.background': '#333333',
        'scrollbarSlider.hoverBackground': '#444444',
        'scrollbarSlider.activeBackground': '#555555',
      },
    });

    document.querySelectorAll('textarea[data-editor]').forEach(setupEditor);
  } catch (err) {
    // Monaco failed to initialise — the original textareas remain usable.
  }

  function setupEditor(textarea) {
    var t = textarea;
    if (!t.parentNode) return;

    var protoValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    var protoReadOnly = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'readOnly');

    var rows = parseInt(t.getAttribute('rows'), 10) || 4;
    var host = document.createElement('div');
    host.className = 'monaco-host';
    host.style.height = Math.max(96, rows * 20 + 28) + 'px';
    t.parentNode.insertBefore(host, t);
    t.classList.add('monaco-original');

    var editor = null;
    var currentValue = t.value;
    var currentReadOnly = !!t.readOnly;

    Object.defineProperty(t, 'value', {
      configurable: true,
      enumerable: true,
      get: function () { return currentValue; },
      set: function (v) {
        v = v == null ? '' : String(v);
        currentValue = v;
        protoValue.set.call(t, v);
        if (editor && v !== editor.getValue()) editor.setValue(v);
      },
    });

    Object.defineProperty(t, 'readOnly', {
      configurable: true,
      enumerable: true,
      get: function () {
        return editor ? editor.getOption(monaco.editor.EditorOption.readOnly) : currentReadOnly;
      },
      set: function (v) {
        currentReadOnly = !!v;
        protoReadOnly.set.call(t, currentReadOnly);
        if (editor) editor.updateOptions({ readOnly: currentReadOnly });
      },
    });

    editor = monaco.editor.create(host, {
      value: currentValue,
      language: t.dataset.lang || 'plaintext',
      theme: 'at-field-dark',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      lineNumbers: 'on',
      folding: true,
      glyphMargin: false,
      renderLineHighlight: 'all',
      fontFamily: "'JetBrains Mono', 'Monaco', 'Menlo', monospace",
      fontLigatures: true,
      fontSize: 12,
      lineHeight: 18,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      padding: { top: 10, bottom: 10 },
      guides: { indentation: true, highlightActiveIndentation: true },
      renderWhitespace: 'none',
      scrollbar: { vertical: 'auto', horizontal: 'auto', useShadows: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      readOnly: currentReadOnly,
    });

    editor.onDidChangeModelContent(function () {
      currentValue = editor.getValue();
      protoValue.set.call(t, currentValue);
    });

    var form = t.closest('form');
    if (form) {
      form.addEventListener('reset', function () {
        // Native reset writes the internal value directly, bypassing the
        // overridden property. If app code sets `.value` right after reset,
        // editor and DOM already agree and this becomes a no-op.
        setTimeout(function () {
          var realValue = protoValue.get.call(t);
          if (realValue !== currentValue) t.value = realValue;
        }, 0);
      });
    }
  }
})();