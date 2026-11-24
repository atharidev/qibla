// Runs before first paint: light or dark (the visitor's choice, else the system's), and the language
// (the visitor's choice, else the browser's first supported one, else Arabic), so nothing flashes.
(function () {
  var d = document.documentElement, mode = null, lang = null;
  var supported = ['ar', 'en', 'ur', 'id', 'tr', 'fr', 'es', 'pt', 'de', 'ru', 'fa', 'bn', 'hi', 'ms', 'sw', 'zh', 'ja', 'ko', 'he', 'it'];
  try { mode = localStorage.getItem('qibla-mode'); lang = localStorage.getItem('qibla-language'); } catch (e) {}
  if (mode !== 'light' && mode !== 'dark') mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (supported.indexOf(lang) < 0) {
    lang = 'ar';
    var wanted = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < wanted.length; i++) {
      var code = String(wanted[i]).toLowerCase().split('-')[0];
      if (code === 'iw') code = 'he';
      if (code === 'in') code = 'id';
      if (supported.indexOf(code) >= 0) { lang = code; break; }
    }
  }
  d.setAttribute('data-theme', mode);
  d.lang = lang;
  d.dir = ['ar', 'ur', 'fa', 'he'].indexOf(lang) >= 0 ? 'rtl' : 'ltr';
  d.classList.add('js');
})();
