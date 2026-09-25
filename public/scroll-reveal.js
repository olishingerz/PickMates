// Fades + slides content up into place as it scrolls into view. Applied
// automatically to card-like elements so no per-page markup changes are
// needed; skipped entirely for prefers-reduced-motion or if
// IntersectionObserver isn't available.
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  var targets = document.querySelectorAll('.card, .game-card, main > .alert');
  if (!targets.length) return;

  // Anything already on screen (or above it) when the page loads is shown
  // immediately, no animation — content that's already in the initial
  // viewport must never be left invisible waiting on a scroll that may
  // never happen. Only elements genuinely below the fold at load time get
  // the reveal-on-scroll treatment.
  var vh = window.innerHeight;
  var toAnimate = [];
  targets.forEach(function (el) {
    if (el.getBoundingClientRect().top < vh) {
      el.classList.add('reveal', 'in-view');
    } else {
      toAnimate.push(el);
    }
  });
  if (!toAnimate.length) return;

  // Each observer callback fires with the batch of elements that crossed
  // the threshold together, so staggering by position within that batch
  // (rather than a fixed page-order index) keeps unrelated, far-apart
  // elements from inheriting a stale/maxed-out delay.
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
  }, { threshold: 0.1 });

  toAnimate.forEach(function (el) {
    el.classList.add('reveal');
    observer.observe(el);
  });
})();
