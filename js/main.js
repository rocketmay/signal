// Minimal JS: set active nav item based on filename
(() => {
  const page = (location.pathname.split('/').pop() || 'index.html');
  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.dataset.page === page) el.classList.add('active');
  });
})();

(function () {
  function getRandom(min, max) {
    return Math.random() * (max - min) + min;
  }

  function flicker() {
    document.body.classList.add('signal-active');

    /* Hold for 0.3–1.2 seconds */
    setTimeout(() => {
      document.body.classList.remove('signal-active');

      /* Wait 5–10 seconds before next flicker */
      setTimeout(flicker, getRandom(5000, 10000));
    }, getRandom(600, 1500));
  }

  /* Initial delay so page loads clean */
  setTimeout(flicker, getRandom(3000, 6000));
})();