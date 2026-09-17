// Fades + slides content up into place as it scrolls into view. Applied
// automatically to card-like elements so no per-page markup changes are
// needed; skipped entirely for prefers-reduced-motion or if
// IntersectionObserver isn't available.
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  var targets = document.querySelectorAll('.card, .game-card, main > .alert');
  if (!targets.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  targets.forEach(function (el, i) {
    el.classList.add('reveal');
    el.style.transitionDelay = Math.min(i * 40, 240) + 'ms';
    observer.observe(el);
  });
})();
