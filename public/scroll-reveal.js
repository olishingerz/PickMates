// Fades + slides content up into place as it scrolls into view. Applied
// automatically to card-like elements so no per-page markup changes are
// needed; skipped entirely for prefers-reduced-motion or if
// IntersectionObserver isn't available.
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  var targets = document.querySelectorAll('.card, .game-card, main > .alert');
  if (!targets.length) return;

  // rootMargin starts the reveal a bit before an element reaches the
  // viewport edge, so it's mid-animation (not just starting) by the time
  // it's actually visible — avoids the "pop in" look of animating exactly
  // on arrival. Each observer callback fires with the batch of elements
  // that crossed the threshold together, so staggering by position within
  // that batch (rather than a fixed page-order index) keeps unrelated,
  // far-apart elements from inheriting a stale/maxed-out delay.
  var observer = new IntersectionObserver(function (entries) {
    var i = 0;
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      el.style.transitionDelay = Math.min(i * 70, 210) + 'ms';
      i++;
      el.classList.add('in-view');
      el.addEventListener('transitionend', function () {
        el.style.willChange = 'auto';
      }, { once: true });
      observer.unobserve(el);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -10% 0px' });

  targets.forEach(function (el) {
    el.classList.add('reveal');
    observer.observe(el);
  });
})();
